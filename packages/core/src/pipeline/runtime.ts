// StoryRuntime 编排器（创作规划 §10.2 对外 API 面 M2 形态；§7 M2 验收的运行时核心）。
// 接线（app/CLI 只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createSnapshotHooks（导航原子恢复）
//   ↔ 主叙事 AgentSession（零工具 + before_agent_start 每轮注入 DB 摘要）
//   ↔ runDataStage（data subagent：抽取落库，唯一写者，§6.1）。
//
// 关键接线决策（与 M1 一致，文件头复述）：
// 1. 快照绑定本轮 leaf（最终 assistant entry），与 turn_log 同一 id。pi navigateTree 语义：
//    导航 u_N → newLeaf = a_{N-1} → 命中 a_{N-1} 快照（第 N-1 轮末）；导航 a_N → 命中自身快照。
//    user-entry 绑定会恢复出「第 N 轮结束后」，重做时事件会双重落库 —— 故绑定 assistant leaf。
// 2. 主叙事零 DB 工具：customTools=[] + tools=[]（严格白名单空数组）；上下文全由编排器注入
//    （§6.0），DB 摘要在 before_agent_start 每轮现算（getter 读当前 storyDb 实例，恢复/回溯后
//    自然准确）。构建后断言 getActiveToolNames() 为空；非空则回退 noTools:"builtin" 重建。
// 3. data 阶段（§6.1）：成功 → recordDataStatus(ok) + markFailedTurnsCompensated + 拍快照；
//    失败 → recordDataStatus(failed)、**不拍快照**（拍摄前提 = 落库成功），未落库内容下轮补齐；
//    连续失败 ≥ threshold 时 onWarning 明确提示用户。
// 4. turnSeq 从 turn_log 最大 +1（core 内 computeNextTurnSeq，与 m1-cli 同源）。
//
// 坑：
// - session.prompt 必须 await 完（isStreaming=false）才能 navigateTree（spike/05 实证）。
// - 恢复（restore）用新 StoryDb 实例替换，旧连接被关闭；任何长期持有 storyDb 的闭包
//   （除 getter）都会在恢复后读到已关闭连接。

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type ModelRuntime,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { StoryDb } from "../db/story-db.ts";
import type { SnapshotsDb } from "../snapshot/snapshots-db.ts";
import { buildAncestorChain } from "../snapshot/ancestors.ts";
import { createSnapshotHooks, type SnapshotHooks } from "../snapshot/hooks.ts";
import { takeSnapshot } from "../snapshot/snapshots-db.ts";
import type { TavernModels, TavernSettings } from "../settings.ts";
import { loadPrompt, renderPlaceholders, type PromptLayerDirs } from "../prompts/loader.ts";
import type { SubagentRunOptions } from "../subagent/runtime.ts";
import { runDataStage, type DataStageOptions, type DataStageOutcome } from "./data-stage.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";

/** 当前最大 turn_seq 的下一轮（turn_log 每轮一行，PK 保证完整性；新库为 1）。与 m1-cli 同源。 */
export function computeNextTurnSeq(storyDb: StoryDb): number {
	const logs = storyDb.reader.getTurnLog();
	const last = logs.at(-1);
	return last ? last.turn_seq + 1 : 1;
}

/** 本轮 user entry id = prompt 前 leaf 的新 user 子条目（正常 prompt 流恒成立）；供导航「重做该轮」定位。 */
function getUserEntryId(sessionManager: SessionManager, beforeLeaf: string | null): string {
	const newUser = sessionManager.getEntries().find(
		(e) => e.type === "message" && e.message.role === "user" && e.parentId === beforeLeaf,
	);
	if (!newUser) {
		throw new Error(`prompt 后未找到新 user entry（beforeLeaf=${beforeLeaf}）——快照绑定失败`);
	}
	return newUser.id;
}

/** 最后一个非空 assistant 文本回复（本轮叙事正文）。 */
function extractLastAssistantReply(messages: ReadonlyArray<{ role: string; content?: unknown }>): string | undefined {
	for (const msg of [...messages].reverse()) {
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		const text = (msg.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		if (text.trim() !== "") return text;
	}
	return undefined;
}

/** data_status 中 status='failed' 的轮次，join turn_log 取 user_input/narrative_text（待补齐轮）。 */
function computePendingTurns(storyDb: StoryDb): DataStageOptions["input"]["pendingTurns"] {
	const failedTurns = storyDb.reader.listDataStatus().filter((r) => r.status === "failed").map((r) => r.turn_seq);
	if (failedTurns.length === 0) return [];
	const turnLogs = new Map(storyDb.reader.getTurnLog().map((t) => [t.turn_seq, t]));
	return failedTurns.map((turnSeq) => {
		const row = turnLogs.get(turnSeq);
		return row
			? { turnSeq, userInput: row.user_input, narrativeText: row.narrative_text }
			: { turnSeq, userInput: "", narrativeText: "" };
	});
}

/** 从最新往前连续 'failed' 计数（'ok'/'compensated' 断串）——连续失败提示阈值依据。 */
function countConsecutiveFailures(storyDb: StoryDb): number {
	let count = 0;
	for (const row of [...storyDb.reader.listDataStatus()].reverse()) {
		if (row.status === "failed") count++;
		else break;
	}
	return count;
}

/** 解析角色模型（settings.models.<role> → modelRuntime.getModel）；解析失败/无配置 → undefined + onWarning。 */
function resolveRoleModel(
	settings: TavernSettings | undefined,
	role: keyof TavernModels,
	modelRuntime: ModelRuntime | undefined,
	onWarning: ((m: string) => void) | undefined,
): SubagentRunOptions["model"] {
	if (modelRuntime === undefined) return undefined;
	const ref = settings?.models[role];
	if (!ref) return undefined;
	const model = modelRuntime.getModel(ref.provider, ref.id);
	if (!model) {
		onWarning?.(`模型解析失败: ${role}=${ref.provider}/${ref.id}（modelRuntime.getModel 返回空，使用 pi 默认模型）`);
	}
	return model ?? undefined;
}

export interface StoryState {
	storyDir: string;
	storyDb: StoryDb;
	snapshotsDb: SnapshotsDb;
}

export interface StoryRuntimeOptions {
	cwd: string;
	sessionManager: SessionManager;
	storyState: StoryState;
	settings?: TavernSettings;
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	onWarning?: (m: string) => void;
	/** data 重试上限（默认 3）。 */
	maxDataAttempts?: number;
	/** 连续失败提示阈值（默认 3）。 */
	failureWarningThreshold?: number;
	/** data 执行器注入（验收故障注入）。 */
	dataExecutor?: DataStageOptions["executor"];
}

export interface TurnResult {
	turnSeq: number;
	userEntryId: string;
	leafId: string;
	narrativeText: string;
	data: DataStageOutcome;
	snapshotTaken: boolean;
	consecutiveDataFailures: number;
}

export interface StoryRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	storyState: StoryState;
	hooks: SnapshotHooks;
	runTurn(input: string): Promise<TurnResult>;
	dispose(): void;
}

/** 构建一次完整 M2 接线运行态（fork 后以新故事目录重建新实例）。 */
export async function createStoryRuntime(opts: StoryRuntimeOptions): Promise<StoryRuntime> {
	const { cwd, sessionManager, storyState, settings, modelRuntime, prompts, eventLog, onWarning } = opts;
	const maxDataAttempts = opts.maxDataAttempts ?? 3;
	const failureWarningThreshold = opts.failureWarningThreshold ?? 3;

	const hooks = createSnapshotHooks({
		snapshotsDb: storyState.snapshotsDb,
		getStoryDb: () => storyState.storyDb,
		setStoryDb: (db) => {
			storyState.storyDb = db;
		},
		getEntryAncestors: (entryId) => buildAncestorChain(sessionManager.getEntries(), entryId),
		onWarning,
	});

	// 主叙事提示词模板（含 {{db_summary}} 占位符，before_agent_start 每轮现算注入）。
	const narratorTemplate = loadPrompt("narrator", prompts).content;
	const narratorModel = resolveRoleModel(settings, "narrator", modelRuntime, onWarning);
	const dataModel = resolveRoleModel(settings, "data", modelRuntime, onWarning);

	const extensionFactories: Array<(pi: ExtensionAPI) => void> = [
		(pi) => {
			pi.on("session_before_tree", (event, ctx) => {
				hooks.sessionBeforeTree(event, ctx);
			});
			pi.on("session_tree", (event, ctx) => {
				hooks.sessionTree(event, ctx);
			});
			// DB 摘要每轮注入通道：before_agent_start 每次 prompt 触发一次，整串替换当轮系统提示。
			// renderPlaceholders 只替换 {{db_summary}}，其余模板原样保留。
			pi.on("before_agent_start", () => ({
				systemPrompt: renderPlaceholders(narratorTemplate, {
					db_summary: renderDbSummary(storyState.storyDb),
				}).text,
			}));
		},
	];

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => narratorTemplate,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
		extensionFactories,
	});
	await loader.reload();

	// 零工具会话：tools 是严格白名单，空数组 = 零工具（§6.0 主叙事不持有 DB 工具）。
	// 构建后断言；若非空（SDK 行为异常）则回退 noTools:"builtin" 重建（customTools 为空，
	// noTools 只会关闭内置工具，最终仍为零工具）。
	const sessionOptions: CreateAgentSessionOptions = {
		cwd,
		sessionManager,
		resourceLoader: loader,
		customTools: [],
		tools: [],
		model: narratorModel,
		modelRuntime,
	};
	let created = await createAgentSession(sessionOptions);
	let session = created.session;
	if (session.getActiveToolNames().length > 0) {
		session.dispose();
		created = await createAgentSession({ ...sessionOptions, tools: undefined, noTools: "builtin" });
		session = created.session;
	}
	if (created.modelFallbackMessage) {
		console.warn(`[warn] ${created.modelFallbackMessage}`);
	}

	const runTurn = async (input: string): Promise<TurnResult> => {
		if (session.isStreaming) {
			throw new Error("isStreaming 期间不能 prompt（应等待上一轮完成）");
		}
		const beforeCount = session.state.messages.length;
		const beforeLeaf = sessionManager.getLeafId();
		const turnSeq = computeNextTurnSeq(storyState.storyDb);
		const startedAt = Date.now();

		await session.prompt(input);

		const leafId = sessionManager.getLeafId();
		if (leafId === null) {
			throw new Error("prompt 后无 leaf entry（会话树异常）");
		}
		const userEntryId = getUserEntryId(sessionManager, beforeLeaf);
		const narrativeText = extractLastAssistantReply(session.state.messages.slice(beforeCount)) ?? "";

		// turn_log 与快照都绑定本轮 leaf（最终 assistant entry）：导航到 user u_N 重做第 N 轮时
		// 恢复第 N-1 轮末状态，保证一致性且防止事件双重落库（见文件头决策 1）。
		storyState.storyDb.writer.recordTurnLog({
			turnSeq,
			sessionEntryId: leafId,
			userInput: input,
			narrativeText,
		});

		// data 阶段：抽取落库（唯一写者，§6.1）。pendingTurns = 此前失败未入库轮。
		const data = await runDataStage({
			storyDb: storyState.storyDb,
			input: { turnSeq, userInput: input, narrativeText, createdEntryId: leafId, pendingTurns: computePendingTurns(storyState.storyDb) },
			cwd,
			model: dataModel,
			modelRuntime,
			prompts,
			eventLog,
			maxAttempts: maxDataAttempts,
			executor: opts.dataExecutor,
		});

		let snapshotTaken = false;
		if (data.ok) {
			storyState.storyDb.writer.recordDataStatus({ turnSeq, status: "ok", attempts: data.attempts });
			// 本轮落库成功 → 此前失败的待补轮一并视作已补齐（§6.1 下轮补齐语义）。
			storyState.storyDb.writer.markFailedTurnsCompensated();
			await takeSnapshot(storyState.storyDb, { turnSeq, sessionEntryId: leafId });
			snapshotTaken = true;
		} else {
			// §6.1：data 失败不拍快照（拍摄前提 = 落库成功），叙事照常呈现。
			storyState.storyDb.writer.recordDataStatus({
				turnSeq,
				status: "failed",
				attempts: data.attempts,
				error: data.error,
			});
		}

		const consecutiveDataFailures = countConsecutiveFailures(storyState.storyDb);
		if (consecutiveDataFailures >= failureWarningThreshold) {
			onWarning?.(
				`data 落库已连续失败 ${consecutiveDataFailures} 轮（阈值 ${failureWarningThreshold}）——本轮及此前失败的叙事事实尚未入库，请留意；下轮将继续尝试补齐（§6.1）`,
			);
		}

		eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq,
			role: "narrator",
			ok: true,
			durationMs: Date.now() - startedAt,
			outputChars: narrativeText.length,
		});

		return { turnSeq, userEntryId, leafId, narrativeText, data, snapshotTaken, consecutiveDataFailures };
	};

	return {
		session,
		sessionManager,
		storyState,
		hooks,
		runTurn,
		dispose: () => {
			session.dispose();
		},
	};
}
