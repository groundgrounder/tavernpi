// StoryRuntime 编排器（创作规划 §10.2 对外 API 面；§7 M3/M4 验收的运行时核心）。
// 接线（app/CLI 只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createSnapshotHooks（导航原子恢复）
//   ↔ 主叙事 AgentSession（零工具 + before_agent_start 每轮注入 DB 摘要 + 预演/场景卡/统筹/打回批注）
//   ↔ npc 阶段（§6.2：场景规划 → 在场预演 ×N 并行 + 离线批量推演 → 主叙事 → data）
//   ↔ story 阶段（§6.3：场景分析最前 → 轻检/打回循环 → 全统筹）
//   ↔ stylize（§6.4：可选，审查通过后、data 前；只改文风不动事实）
//   ↔ runDataStage（data subagent：抽取落库，唯一写者，§6.1）
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
// 5. 打回重写（§6.3 轻检）：navigateTree(userEntryId) 会触发快照钩子恢复到第 N-1 轮末快照——
//    本轮 data 尚未运行（语义无害）；恢复替换 storyDb 实例，故重写循环内所有 DB 读取都必须
//    经 storyState.storyDb 属性在调用时现取（story-stage 的 options.storyDb 逐调用注入当前实例）。
// 6. userEntryId 从最终 leaf 沿 parentId 上溯取第一个 user entry（findUserEntryOnBranch）——
//    打回重写后旧稿 u_N 与新稿 u_N' 同 parentId，find-first 会误中旧稿。
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
import type { NpcRow } from "../db/types.ts";
import {
	renderOverseeNote,
	renderRevisionRequest,
	renderSceneCardForNarrator,
	runOversee,
	runReview,
	runRuleChecks,
	runSceneAnalysis,
	type OverseeNote,
	type ReviewFinding,
	type SceneCard,
	type StoryStageOptions,
} from "./story-stage.ts";
import { runStylize, type StylizeOptions } from "./stylize-stage.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";

/** 当前最大 turn_seq 的下一轮（turn_log 每轮一行，PK 保证完整性；新库为 1）。与 m1-cli 同源。 */
export function computeNextTurnSeq(storyDb: StoryDb): number {
	const logs = storyDb.reader.getTurnLog();
	const last = logs.at(-1);
	return last ? last.turn_seq + 1 : 1;
}

/**
 * 从最终 leaf 沿 parentId 上溯找第一个 user entry（§6.3 打回重写后原 u_N 与新 u_N' 同 parentId，
 * find-first 会误中旧稿；本函数从最终 leaf 出发，命中新稿所在分支的 user entry）。找不到返回 null。
 */
export function findUserEntryOnBranch(
	entries: ReadonlyArray<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
	leafId: string,
): string | null {
	const byId = new Map(entries.map((e) => [e.id, e]));
	let cur = byId.get(leafId) ?? null;
	while (cur !== null) {
		if (cur.type === "message" && cur.message?.role === "user") return cur.id;
		cur = cur.parentId !== null ? byId.get(cur.parentId) ?? null : null;
	}
	return null;
}

/** 从 leaf 上溯取 user entry，缺失即抛（正常 prompt 流恒成立；供快照绑定/navigateTree 定位）。 */
function assertUserEntryOnBranch(
	entries: ReadonlyArray<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
	leafId: string,
): string {
	const id = findUserEntryOnBranch(entries, leafId);
	if (id === null) {
		throw new Error(`从 leaf ${leafId} 上溯未找到 user entry——快照绑定失败`);
	}
	return id;
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

/** 近期叙事窗口（turn_log 后 N 条）——场景分析/全统筹的输入（§6.3）。 */
function recentNarratives(storyDb: StoryDb, n: number): Array<{ turnSeq: number; userInput: string; narrativeText: string }> {
	return storyDb.reader.getTurnLog().slice(-n).map((t) => ({
		turnSeq: t.turn_seq,
		userInput: t.user_input,
		narrativeText: t.narrative_text,
	}));
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

/** npc subagent 阶段运行时选项（§6.2）。enabled 缺省 false——M2/M3 路径（npc 关闭）零改动。 */
export interface NpcStageRuntimeOptions {
	enabled: boolean;
	/** 离线推演触发阈值：距上次推演 ≥ N 轮触发（默认 5）。 */
	offscreenAfterTurns?: number;
	/** 每 NPC / 每批重试上限（默认 2）。 */
	maxAttempts?: number;
	/** npc 执行器注入（验收故障注入，npc 专用）。 */
	executor?: NpcStageOptions["executor"];
}

/** story subagent 阶段运行时选项（§6.3）。enabled 缺省 false——M2/M3 路径（story 关闭）零改动。 */
export interface StoryStageRuntimeOptions {
	enabled: boolean;
	/** 打回重写上限（默认 1 = 最多 2 稿，§6.3「上限 1–2 次」）；超限放行（strictDrop）。 */
	maxRevisions?: number;
	/** 全统筹轮期间隔（默认 10；sceneCard.major_event 也触发）。 */
	overseeEveryTurns?: number;
	/** 场景分析/全统筹的近期叙事窗口（默认 5，从 turn_log 取）。 */
	recentNarratives?: number;
	/** story 执行器注入（验收故障注入，story 专用）。 */
	executor?: StoryStageOptions["executor"];
}

/** stylize 阶段运行时选项（§6.4）。enabled 缺省 false（默认关闭）。 */
export interface StylizeRuntimeOptions {
	enabled: boolean;
	/** 文风目标（世界包文风字段 M5 接入；现为故事级覆盖）。 */
	styleHint?: string;
	/** 重试上限（默认 2）。 */
	maxAttempts?: number;
	/** stylize 执行器注入（验收故障注入）。 */
	executor?: StylizeOptions["executor"];
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
	/** story subagent 阶段（§6.3）。缺省关闭（M3 形态不变）。 */
	story?: StoryStageRuntimeOptions;
	/** stylize 阶段（§6.4）。缺省关闭。 */
	stylize?: StylizeRuntimeOptions;
	/** 系统提示渲染完成回调（§10.2 pipeline 可观测性）：before_agent_start 每次注入后调用，
	 *  参数为渲染好的当轮系统提示全文（含 db_summary 与当轮预演/场景卡/统筹/打回批注）。观测钩子，不影响渲染语义。 */
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
	/** story 阶段报告（§6.3；story 关闭时缺省）。 */
	story?: {
		sceneCard: SceneCard;
		sceneFallback: boolean;
		hardConflicts: string[];
		suspicions: string[];
		reviewFindings: ReviewFinding[];
		/** 实际重写次数。 */
		revisions: number;
		/** 超限放行（重写仍冲突 → 放行，冲突留 turn_log.warnings + data strictDrop）。 */
		releasedWithWarnings: boolean;
	};
	/** stylize 报告（§6.4；stylize 关闭时缺省）。 */
	stylize?: { applied: boolean; drift?: string[] };
	/** 全统筹批注（§6.3；本轮触发则为 note，未触发字段缺省，触发但失败为 null）。 */
	oversee?: OverseeNote | null;
}

export interface StoryRuntime {
	session: AgentSession;
	sessionManager: SessionManager;
	storyState: StoryState;
	hooks: SnapshotHooks;
	runTurn(input: string): Promise<TurnResult>;
	dispose(): void;
}

/** 构建一次完整接线运行态（fork 后以新故事目录重建新实例）。 */
export async function createStoryRuntime(opts: StoryRuntimeOptions): Promise<StoryRuntime> {
	const { cwd, sessionManager, storyState, settings, modelRuntime, prompts, eventLog, onWarning } = opts;
	const maxDataAttempts = opts.maxDataAttempts ?? 3;
	const failureWarningThreshold = opts.failureWarningThreshold ?? 3;
	// 阶段选项：缺省全部关闭（enabled=false，M2/M3 形态不变）。
	const npcOpts: NpcStageRuntimeOptions = { enabled: false, ...opts.npc };
	const storyOpts: StoryStageRuntimeOptions = { enabled: false, ...opts.story };
	const stylizeOpts: StylizeRuntimeOptions = { enabled: false, ...opts.stylize };

	const hooks = createSnapshotHooks({
		snapshotsDb: storyState.snapshotsDb,
		getStoryDb: () => storyState.storyDb,
		setStoryDb: (db) => {
			storyState.storyDb = db;
		},
		getEntryAncestors: (entryId) => buildAncestorChain(sessionManager.getEntries(), entryId),
		onWarning,
	});

	// 主叙事提示词模板（占位符 before_agent_start 每轮现算注入）。
	const narratorTemplate = loadPrompt("narrator", prompts).content;
	const narratorModel = resolveRoleModel(settings, "narrator", modelRuntime, onWarning);
	const dataModel = resolveRoleModel(settings, "data", modelRuntime, onWarning);
	const npcModel = resolveRoleModel(settings, "npc", modelRuntime, onWarning);
	const storyModel = resolveRoleModel(settings, "story", modelRuntime, onWarning);
	const stylizeModel = resolveRoleModel(settings, "stylize", modelRuntime, onWarning);

	// story 阶段 runner 公共选项（storyDb 逐调用注入当前实例——重写循环经快照恢复替换实例后不能持有旧连接）。
	const storyStageOptsBase: Omit<StoryStageOptions, "storyDb"> = {
		cwd,
		model: storyModel,
		modelRuntime,
		prompts,
		eventLog,
		executor: storyOpts.executor,
	};

	// 主叙事注入闭包：每轮现算；turn 结束后复位（预演/场景卡/打回只属当轮，统筹产物给下一轮）。
	let pendingRehearsals: string | undefined;
	let pendingSceneCard: SceneCard | undefined;
	let pendingOverseeNote: string | undefined;
	let pendingRevision: string | undefined;

	const extensionFactories: Array<(pi: ExtensionAPI) => void> = [
		(pi) => {
			pi.on("session_before_tree", (event, ctx) => {
				hooks.sessionBeforeTree(event, ctx);
			});
			pi.on("session_tree", (event, ctx) => {
				hooks.sessionTree(event, ctx);
			});
			// 每轮注入通道：before_agent_start 每次 prompt 触发一次，整串替换当轮系统提示。
			// renderPlaceholders 只替换已知占位符，其余模板原样保留。
			// onSystemPromptRender：渲染完成回调（§10.2 可观测性），供验收/观测钩子读取注入内容。
			pi.on("before_agent_start", () => {
				const rendered = renderPlaceholders(narratorTemplate, {
					db_summary: renderDbSummary(storyState.storyDb),
					// npc 未启用时 pendingRehearsals 恒 undefined → 占位符渲染为「无在场 NPC 预演」
					npc_rehearsals: pendingRehearsals ?? "（本轮无在场 NPC 预演）",
					// story 未启用时 pendingSceneCard 恒 undefined → 渲染为「（无）」
					scene_card: pendingSceneCard ? renderSceneCardForNarrator(pendingSceneCard, storyState.storyDb) : "（无）",
					oversee_note: pendingOverseeNote ?? "（无）",
					revision_request: pendingRevision ?? "（无）",
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
		const turnSeq = computeNextTurnSeq(storyState.storyDb);
		const startedAt = Date.now();

		// ---- story 阶段①：场景分析在最前，产出场景卡（npc 调度 / data 时间建议 / 轻检依据）----
		let sceneCard: SceneCard | undefined;
		let sceneFallback = false;
		if (storyOpts.enabled) {
			const analysis = await runSceneAnalysis(
				{ turnSeq, userInput: input, recentNarratives: recentNarratives(storyState.storyDb, storyOpts.recentNarratives ?? 5) },
				{ ...storyStageOptsBase, storyDb: storyState.storyDb },
			);
			sceneCard = analysis.card;
			sceneFallback = analysis.fallback;
			pendingSceneCard = analysis.card;
		}

		// ---- npc 阶段（§6.2）：场景卡驱动在场/离线名单；story 关闭时维持 M3 确定性判定 ----
		let npcReport: TurnResult["npc"];
		if (npcOpts.enabled) {
			const allNpcs = storyState.storyDb.reader.listNpcs();
			const npcById = new Map(allNpcs.map((n) => [n.id, n]));
			let onstageNpcs: NpcRow[] = [];
			let offscreenTriggered: NpcRow[] = [];
			if (storyOpts.enabled && sceneCard) {
				// 在场 = onstage_npc_ids（场景卡校验已保证合法）；离线 = offscreen_npc_ids ∪ K 轮确定性
				// 兜底（computeScenePlan，防场景卡漏列久未推演者），去重并排除在场。
				onstageNpcs = sceneCard.onstage_npc_ids
					.map((id) => npcById.get(id))
					.filter((n): n is NpcRow => n !== undefined);
				const union = new Map<number, NpcRow>();
				for (const off of sceneCard.offscreen_npc_ids) {
					const n = npcById.get(off.npc_id);
					if (n) union.set(n.id, n);
				}
				for (const n of computeScenePlan(storyState.storyDb, turnSeq, {
					offscreenAfterTurns: npcOpts.offscreenAfterTurns,
				}).offscreenTriggered) {
					union.set(n.id, n);
				}
				const onstageSet = new Set(onstageNpcs.map((n) => n.id));
				offscreenTriggered = [...union.values()].filter((n) => !onstageSet.has(n.id));
			} else {
				const scenePlan = computeScenePlan(storyState.storyDb, turnSeq, {
					offscreenAfterTurns: npcOpts.offscreenAfterTurns,
				});
				onstageNpcs = scenePlan.onstage;
				offscreenTriggered = scenePlan.offscreenTriggered;
			}
			const npcStageOpts: NpcStageOptions = {
				storyDb: storyState.storyDb,
				cwd,
				model: npcModel,
				modelRuntime,
				prompts,
				eventLog,
				maxAttempts: npcOpts.maxAttempts,
				executor: npcOpts.executor,
				directives: storyOpts.enabled ? storyState.storyDb.reader.listDirectives("active").map((d) => d.content) : undefined,
			};
			const [rehearsals, deltas] = await Promise.all([
				onstageNpcs.length > 0
					? runOnstageRehearsals(onstageNpcs, turnSeq, input, npcStageOpts)
					: Promise.resolve<NpcRehearsal[]>([]),
				offscreenTriggered.length > 0
					? runOffscreenBatch(offscreenTriggered, turnSeq, npcStageOpts)
					: Promise.resolve<OffscreenDelta[]>([]),
			]);
			// 预演产物注入主叙事（before_agent_start 一并渲染）；无在场预演 → 占位文本。
			pendingRehearsals =
				rehearsals.length === 0 ? "（本轮无在场 NPC 预演）" : renderRehearsals(rehearsals, storyState.storyDb);
			npcReport = {
				onstageNpcIds: onstageNpcs.map((n) => n.id),
				rehearsals,
				offscreenTriggeredIds: offscreenTriggered.map((n) => n.id),
				offscreenDeltas: deltas,
			};
		}

		// story 阶段报告累积量（重写循环内更新）
		let hardConflicts: string[] = [];
		let suspicions: string[] = [];
		let reviewFindings: ReviewFinding[] = [];
		let revisions = 0;
		let releasedWithWarnings = false;

		try {
			// ---- 主叙事（§6.3 轻检/打回循环；story 关闭时保持 M3 单 prompt 形态）----
			let promptStart = session.state.messages.length;
			await session.prompt(input);
			let leafId = sessionManager.getLeafId();
			if (leafId === null) {
				throw new Error("prompt 后无 leaf entry（会话树异常）");
			}
			let userEntryId = assertUserEntryOnBranch(sessionManager.getEntries(), leafId);
			let narrativeText = extractLastAssistantReply(session.state.messages.slice(promptStart)) ?? "";

			if (storyOpts.enabled && sceneCard) {
				const maxRevisions = storyOpts.maxRevisions ?? 1;
				for (;;) {
					// 规则层确定性断言（零 LLM，每轮必跑）
					const rule = runRuleChecks({ sceneCard, storyDb: storyState.storyDb, narrativeText, turnSeq });
					hardConflicts = rule.hardConflicts;
					suspicions = rule.suspicions;
					const revisionBasis: string[] = [...rule.hardConflicts];
					let rewriteFindings: ReviewFinding[] = [];
					if (rule.hardConflicts.length > 0) {
						// 规则层硬冲突：直接打回（无需 LLM 审查）
					} else if (rule.suspicions.length > 0) {
						// 报疑 → LLM 审查层核验；severity=hard 并入打回依据
						reviewFindings = await runReview(
							{ turnSeq, narrativeText, suspicions: rule.suspicions, sceneCard },
							{ ...storyStageOptsBase, storyDb: storyState.storyDb },
						);
						rewriteFindings = reviewFindings.filter((f) => f.severity === "hard");
						revisionBasis.push(...rewriteFindings.map((f) => `[${f.kind}] ${f.description}`));
					}
					if (revisionBasis.length === 0) break; // 轻检通过
					if (revisions >= maxRevisions) {
						// 超限放行：冲突留 turn_log.warnings + data strictDrop（§6.3）
						releasedWithWarnings = true;
						break;
					}
					// 打回：navigateTree 到当轮 user entry（钩子恢复到第 N-1 轮末快照——本轮 data 未跑，
					// 语义无害；DB 实例被替换，后续读取一律经 storyState.storyDb 现取）。
					// 防御（首轮/目标链无快照）：此时 navigateTree 会触发「空库兜底」（resetToEmptyStoryDb），
					// 清空 seed 与已落库事实——跳过导航、从当前 leaf 直接重写（旧稿留在上下文，语义偏差可接受，
					// 绝不误清库）；有快照时走标准导航重写路径。
					const rewriteHasSnapshot =
						storyState.snapshotsDb.findNearestSnapshot(buildAncestorChain(sessionManager.getEntries(), userEntryId)) !== undefined;
					if (rewriteHasSnapshot) {
						await session.navigateTree(userEntryId);
					}
					pendingRevision = renderRevisionRequest(rule.hardConflicts, rewriteFindings);
					promptStart = session.state.messages.length;
					await session.prompt(input);
					leafId = sessionManager.getLeafId();
					if (leafId === null) {
						throw new Error("重写后无 leaf entry（会话树异常）");
					}
					narrativeText = extractLastAssistantReply(session.state.messages.slice(promptStart)) ?? "";
					userEntryId = assertUserEntryOnBranch(sessionManager.getEntries(), leafId);
					revisions++;
				}
			}

			// 当轮注入闭包消费完毕复位（统筹产物给下一轮，由下一轮叙事阶段消费后复位）
			pendingRevision = undefined;
			pendingOverseeNote = undefined;

			// ---- stylize（§6.4，默认关闭；轻检通过/放行后、data 前）----
			let finalText = narrativeText;
			let stylizeReport: TurnResult["stylize"];
			if (stylizeOpts.enabled) {
				const res = await runStylize(
					{ turnSeq, narrativeText, styleHint: stylizeOpts.styleHint },
					{
						storyDb: storyState.storyDb,
						cwd,
						model: stylizeModel,
						modelRuntime,
						prompts,
						eventLog,
						maxAttempts: stylizeOpts.maxAttempts,
						executor: stylizeOpts.executor,
					},
				);
				finalText = res.text;
				stylizeReport = { applied: res.applied, drift: res.drift };
			}

			// ---- turn_log：narrativeText = 最终文本（stylize 后）；rawText = stylize 前原文；warnings = 超限放行冲突 ----
			const releasedWarningsText = releasedWithWarnings
				? `本轮轻检未通过但超限放行: ${[
						...hardConflicts,
						...reviewFindings.filter((f) => f.severity === "hard").map((f) => `[${f.kind}] ${f.description}`),
					].join("; ")}`
				: undefined;
			storyState.storyDb.writer.recordTurnLog({
				turnSeq,
				sessionEntryId: leafId,
				userInput: input,
				narrativeText: finalText,
				...(stylizeOpts.enabled ? { rawText: narrativeText } : {}),
				warnings: releasedWarningsText,
			});

			// ---- data 阶段：抽取落库（唯一写者，§6.1）。narrativeText = 最终文本；
			//      timeSuggestion = 场景卡时间建议（§6.3 → §5.3）；strictDrop = 超限放行轮 ----
			const data = await runDataStage({
				storyDb: storyState.storyDb,
				input: {
					turnSeq,
					userInput: input,
					narrativeText: finalText,
					createdEntryId: leafId,
					pendingTurns: computePendingTurns(storyState.storyDb),
					offscreenDeltas: npcReport?.offscreenDeltas,
					...(storyOpts.enabled && sceneCard
						? { timeSuggestion: { estimate: sceneCard.time_span_estimate, toTime: sceneCard.to_time_suggestion } }
						: {}),
				},
				cwd,
				model: dataModel,
				modelRuntime,
				prompts,
				eventLog,
				maxAttempts: maxDataAttempts,
				executor: opts.dataExecutor,
				strictDrop: releasedWithWarnings,
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

			// ---- 全统筹（§6.3 步骤 8：data+快照之后，不阻塞落库；data 失败照跑，统筹不依赖落库成功）----
			let overseeNote: OverseeNote | null | undefined;
			if (storyOpts.enabled && sceneCard) {
				const shouldOversee =
					turnSeq % (storyOpts.overseeEveryTurns ?? 10) === 0 || sceneCard.major_event === true;
				if (shouldOversee) {
					overseeNote = await runOversee(
						{ turnSeq, recentNarratives: recentNarratives(storyState.storyDb, storyOpts.recentNarratives ?? 5), sceneCard },
						{ ...storyStageOptsBase, storyDb: storyState.storyDb },
					);
					pendingOverseeNote = overseeNote ? renderOverseeNote(overseeNote) : undefined;
				}
			}

			eventLog?.record({
				ts: new Date().toISOString(),
				turnSeq,
				role: "narrator",
				ok: true,
				durationMs: Date.now() - startedAt,
				outputChars: finalText.length,
			});

			return {
				turnSeq,
				userEntryId,
				leafId,
				narrativeText: finalText,
				data,
				snapshotTaken,
				consecutiveDataFailures,
				npc: npcReport,
				...(storyOpts.enabled && sceneCard
					? {
							story: {
								sceneCard,
								sceneFallback,
								hardConflicts,
								suspicions,
								reviewFindings,
								revisions,
								releasedWithWarnings,
							},
						}
					: {}),
				stylize: stylizeReport,
				oversee: overseeNote,
			};
		} finally {
			// turn 结束后复位：预演/场景卡/打回只属当轮，不泄漏到后续 prompt（下轮重新填充）。
			// pendingOverseeNote 有跨轮语义（本轮统筹产物下一轮注入），不在 finally 复位。
			pendingRehearsals = undefined;
			pendingSceneCard = undefined;
			pendingRevision = undefined;
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
