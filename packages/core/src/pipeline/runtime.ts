// StoryRuntime 编排器（创作规划 §10.2 对外 API 面 M2 形态；§7 M2 验收的运行时核心）。
// 接线（app/CLI 只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createSnapshotHooks（导航原子恢复）
//   ↔ 主叙事 AgentSession（零工具 + before_agent_start 每轮注入 DB 摘要）
//   ↔ runDataStage（data subagent：抽取落库，唯一写者，§6.1）
//   ↔ npc 阶段（§6.2：场景规划 → 在场预演 ×N 并行 + 离线批量推演 → 主叙事 → data）；
//     预演产物注入主叙事隐藏批注，离线 delta 交 data 转写落库——npc 层永不直接写库，
//     只由编排器在 data.ok 后直写 sys_ 簿记键（同 clock 例外精神）。
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
import {
	computeScenePlan,
	offscreenLastTurnKey,
	renderRehearsals,
	runOffscreenBatch,
	runOnstageRehearsals,
	type NpcRehearsal,
	type NpcStageOptions,
	type OffscreenDelta,
} from "./npc-stage.ts";
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

/** npc subagent 阶段运行时选项（§6.2）。enabled 缺省 false——M2 路径（npc 关闭）零改动。 */
export interface NpcStageRuntimeOptions {
	enabled: boolean;
	/** 离线推演触发阈值：距上次推演 ≥ N 轮触发（默认 5）。 */
	offscreenAfterTurns?: number;
	/** 每 NPC / 每批重试上限（默认 2）。 */
	maxAttempts?: number;
	/** npc 执行器注入（验收故障注入，npc 专用）。 */
	executor?: NpcStageOptions["executor"];
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
	/** npc subagent 阶段（§6.2）。缺省关闭（M2 形态不变）。 */
	npc?: NpcStageRuntimeOptions;
	/** 系统提示渲染完成回调（§10.2 pipeline 可观测性）：before_agent_start 每次注入后调用，
	 *  参数为渲染好的当轮系统提示全文（含 db_summary 与当轮 npc 预演批注）。观测钩子，不影响渲染语义。 */
	onSystemPromptRender?: (rendered: string) => void;
}

export interface TurnResult {
	turnSeq: number;
	userEntryId: string;
	leafId: string;
	narrativeText: string;
	data: DataStageOutcome;
	snapshotTaken: boolean;
	consecutiveDataFailures: number;
	/** npc 阶段报告（§6.2；npc 关闭时缺省）。 */
	npc?: {
		onstageNpcIds: number[];
		rehearsals: NpcRehearsal[];
		offscreenTriggeredIds: number[];
		offscreenDeltas: OffscreenDelta[];
	};
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
	// npc 阶段选项：缺省关闭（enabled=false，M2 形态不变）。
	const npcOpts: NpcStageRuntimeOptions = { enabled: false, ...opts.npc };

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
	const npcModel = resolveRoleModel(settings, "npc", modelRuntime, onWarning);

	// npc 预演产物注入通道（§6.2）：runTurn 的 npc 阶段写入，before_agent_start 一并渲染；
	// turn 结束后复位（只属当轮）。npc 未启用时恒为 undefined → 占位符落「无在场 NPC 预演」。
	let pendingRehearsals: string | undefined;

	const extensionFactories: Array<(pi: ExtensionAPI) => void> = [
		(pi) => {
			pi.on("session_before_tree", (event, ctx) => {
				hooks.sessionBeforeTree(event, ctx);
			});
			pi.on("session_tree", (event, ctx) => {
				hooks.sessionTree(event, ctx);
			});
			// DB 摘要 + npc 预演批注每轮注入通道：before_agent_start 每次 prompt 触发一次，整串替换当轮系统提示。
			// renderPlaceholders 只替换 {{db_summary}} / {{npc_rehearsals}}，其余模板原样保留。
			// onSystemPromptRender：渲染完成回调（§10.2 可观测性），供验收/观测钩子读取注入内容。
			pi.on("before_agent_start", () => {
				const rendered = renderPlaceholders(narratorTemplate, {
					db_summary: renderDbSummary(storyState.storyDb),
					// npc 未启用时 pendingRehearsals 恒 undefined → 占位符渲染为「无在场 NPC 预演」
					// （M2 路径渲染结果含该行，可接受，见规格 §1）。
					npc_rehearsals: pendingRehearsals ?? "（本轮无在场 NPC 预演）",
				}).text;
				opts.onSystemPromptRender?.(rendered);
				return { systemPrompt: rendered };
			});
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

		// npc 阶段（§6.2 时机：场景规划 → npc 并行 → 主叙事 → data）：
		// 在场预演与离线批量推演互不依赖，Promise.all 并行且必须在主叙事 prompt 前完成。
		// 零消耗契约：不在场/未触发 → 不调用 subagent（返回空数组，不产生调用）。
		let npcReport: TurnResult["npc"];
		if (npcOpts.enabled) {
			const scenePlan = computeScenePlan(storyState.storyDb, turnSeq, {
				offscreenAfterTurns: npcOpts.offscreenAfterTurns,
			});
			const npcStageOpts: NpcStageOptions = {
				storyDb: storyState.storyDb,
				cwd,
				model: npcModel,
				modelRuntime,
				prompts,
				eventLog,
				maxAttempts: npcOpts.maxAttempts,
				executor: npcOpts.executor,
			};
			const [rehearsals, deltas] = await Promise.all([
				scenePlan.onstage.length > 0
					? runOnstageRehearsals(scenePlan.onstage, turnSeq, input, npcStageOpts)
					: Promise.resolve<NpcRehearsal[]>([]),
				scenePlan.offscreenTriggered.length > 0
					? runOffscreenBatch(scenePlan.offscreenTriggered, turnSeq, npcStageOpts)
					: Promise.resolve<OffscreenDelta[]>([]),
			]);
			// 预演产物注入主叙事（before_agent_start 一并渲染）；无在场预演 → 占位文本。
			pendingRehearsals =
				rehearsals.length === 0 ? "（本轮无在场 NPC 预演）" : renderRehearsals(rehearsals, storyState.storyDb);
			npcReport = {
				onstageNpcIds: scenePlan.onstage.map((n) => n.id),
				rehearsals,
				offscreenTriggeredIds: scenePlan.offscreenTriggered.map((n) => n.id),
				offscreenDeltas: deltas,
			};
		}

		try {
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

			// data 阶段：抽取落库（唯一写者，§6.1）。pendingTurns = 此前失败未入库轮；
			// offscreenDeltas = 本轮离线推演结构化产物（§6.2），交 data 转写落库（单写者规则不破）。
			const data = await runDataStage({
				storyDb: storyState.storyDb,
				input: {
					turnSeq,
					userInput: input,
					narrativeText,
					createdEntryId: leafId,
					pendingTurns: computePendingTurns(storyState.storyDb),
					offscreenDeltas: npcReport?.offscreenDeltas,
				},
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
				// sys 键簿记（§6.2 内核簿记，编排器直写，同 clock 例外精神）：data 成功才对每个
				// offscreenTriggered NPC 更新离线推演 last-turn 键（快照前写入，随快照持久化）；
				// data 失败不更新 → 下轮自然重触发、delta 重算。
				for (const npcId of npcReport?.offscreenTriggeredIds ?? []) {
					storyState.storyDb.writer.upsertWorldState({
						key: offscreenLastTurnKey(npcId),
						value: String(turnSeq),
						turnSeq,
					});
				}
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

			return {
				turnSeq,
				userEntryId,
				leafId,
				narrativeText,
				data,
				snapshotTaken,
				consecutiveDataFailures,
				npc: npcReport,
			};
		} finally {
			// turn 结束后复位：预演产物只属当轮，不泄漏到后续 prompt（下轮 npc 阶段会重新填充）。
			pendingRehearsals = undefined;
		}
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
