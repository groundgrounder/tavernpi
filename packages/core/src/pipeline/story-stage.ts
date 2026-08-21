// story subagent 纯模块层（创作规划 §6.3 两级运行 / 技术路线 §3.3；M4 纯模块形态）。
//
// 两级运行：
//   1. 场景分析（runSceneAnalysis，每轮最前）：产出场景卡——全部 subagent 的调度依据
//      （在场名单 → npc 预演、离线名单 → 离线推演、时间跨度 → data 推进参考）。
//   2. 审查统筹（runReview / runOversee，主叙事后）：规则层确定性断言（runRuleChecks）每轮必跑
//      零 LLM；LLM 审查层仅在规则层报疑时触发；全统筹按条件触发（每 K 轮或 major_event）。
//
// story 改事实不改文风：正文永远由主叙事执笔，story 只产出调度/约束/批注（渲染器注入）。
//
// 兜底纪律（不阻塞 pipeline）：场景分析重试耗尽 → 降级为 M3 确定性判定（复用 npc-stage 的
// computeScenePlan）+ fallback:true；审查耗尽 → 返回 [] 放行；统筹耗尽 → null。
// eventLog 逐 attempt 记录 role=story_scene / story_review / story_oversee。

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { TSchema } from "typebox";
import type { StoryDb } from "../db/story-db.ts";
import { loadPrompt, type PromptLayerDirs } from "../prompts/loader.ts";
import {
	runSubagent,
	type SubagentOutputTool,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "../subagent/runtime.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";
import { computeScenePlan } from "./npc-stage.ts";

// ---------------------------------------------------------------------------
// 场景卡 schema（预算约束同 M3 风格）
// ---------------------------------------------------------------------------

const sceneCardSchema = z.object({
	onstage_npc_ids: z.array(z.number().int().positive()).max(8), // 在场 NPC（调度 npc 预演）
	offscreen_npc_ids: z
		.array(
			z.object({
				npc_id: z.number().int().positive(),
				reason: z.string().max(60),
			}),
		)
		.max(8), // 需离线推演名单及原因
	scene_location_name: z.string().max(60), // 当前场景地点（须已登记）
	current_story_time: z.string().max(40), // 当前故事时间（须与 clock 一致，防幻觉）
	time_span_estimate: z.string().max(60), // 本轮时间跨度估计（如「几句话的工夫」）
	to_time_suggestion: z.string().max(40), // 建议推进至（供 data 时间推进参考，§5.3 流转链路正式化）
	scene_goal: z.string().max(100),
	tone: z.string().max(40),
	major_event: z.boolean(), // 全统筹触发依据之一
});

export const sceneCardZodSchema = sceneCardSchema;
export type SceneCard = z.infer<typeof sceneCardSchema>;
export const SCENE_CARD_JSON_SCHEMA = sceneCardSchema.toJSONSchema() as unknown as TSchema;

// ---------------------------------------------------------------------------
// 审查 / 统筹 schema
// ---------------------------------------------------------------------------

const reviewFindingSchema = z.object({
	kind: z.enum(["timeline", "knowledge", "ooc", "world"]),
	description: z.string().max(200),
	severity: z.enum(["hard", "soft"]),
});
const reviewSchema = z.object({ findings: z.array(reviewFindingSchema).max(8) });

export const reviewZodSchema = reviewSchema;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export const REVIEW_JSON_SCHEMA = reviewSchema.toJSONSchema() as unknown as TSchema;

const overseeSchema = z.object({
	pacing: z.string().max(150),
	open_threads: z.array(z.string().max(80)).max(5),
	suggestions: z.array(z.string().max(120)).max(5),
	phase_advice: z.object({
		action: z.enum(["start", "end", "none"]),
		name: z.string().max(60).optional(),
		goals: z.string().max(150).optional(),
	}),
});

export const overseeZodSchema = overseeSchema;
export type OverseeNote = z.infer<typeof overseeSchema>;
export const OVERSEE_JSON_SCHEMA = overseeSchema.toJSONSchema() as unknown as TSchema;

// ---------------------------------------------------------------------------
// 输出工具与通用选项
// ---------------------------------------------------------------------------

export const SCENE_OUTPUT_TOOL_NAME = "submit_scene_card";
export const REVIEW_OUTPUT_TOOL_NAME = "submit_review";
export const OVERSEE_OUTPUT_TOOL_NAME = "submit_oversee";

const SCENE_TOOL: SubagentOutputTool = {
	name: SCENE_OUTPUT_TOOL_NAME,
	description: "提交本轮场景卡（唯一输出通道）。必须且只调用一次。",
	schema: SCENE_CARD_JSON_SCHEMA,
};
const REVIEW_TOOL: SubagentOutputTool = {
	name: REVIEW_OUTPUT_TOOL_NAME,
	description: "提交审查 findings（唯一输出通道）。findings 为空 = 通过。必须且只调用一次。",
	schema: REVIEW_JSON_SCHEMA,
};
const OVERSEE_TOOL: SubagentOutputTool = {
	name: OVERSEE_OUTPUT_TOOL_NAME,
	description: "提交全统筹批注（唯一输出通道）。必须且只调用一次。",
	schema: OVERSEE_JSON_SCHEMA,
};

export interface StoryStageOptions {
	storyDb: StoryDb;
	cwd: string;
	model?: SubagentRunOptions["model"];
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	/** 每 runner 重试上限（默认 2）。 */
	maxAttempts?: number;
	/** 缺省 runSubagent；测试/验收故障注入通道。 */
	executor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
}

const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

// ---------------------------------------------------------------------------
// 场景分析（runSceneAnalysis）
// ---------------------------------------------------------------------------

const SCENE_INSTRUCTIONS = [
	"场景卡是所有 subagent 的调度依据：给出精确的在场/离线名单（用 NPC id）。",
	"current_story_time 必须从上方 DB 摘要照抄，不得改写或推测。",
	"to_time_suggestion 不早于当前故事时间（字典序）。",
	"离线名单只列需要推演的（玩家即将打交道的、久未推演的），不必全列。",
	"输出必须且只调用一次 submit_scene_card 工具提交。",
].join("\n");

/** 场景卡语义校验：npc 存在且非 dead/absent（在场）、场景地点已登记、current_story_time == clock。 */
export function validateSceneCard(storyDb: StoryDb, card: SceneCard): string[] {
	const problems: string[] = [];
	const npcById = new Map(storyDb.reader.listNpcs().map((n) => [n.id, n]));
	for (const id of card.onstage_npc_ids) {
		const npc = npcById.get(id);
		if (!npc) {
			problems.push(`onstage_npc_ids 引用不存在的 NPC #${id}`);
		} else if (npc.status === "dead" || npc.status === "absent") {
			problems.push(`onstage_npc_ids 含不可在场 NPC #${id}（status: ${npc.status}）`);
		}
	}
	for (const off of card.offscreen_npc_ids) {
		const npc = npcById.get(off.npc_id);
		if (!npc) {
			problems.push(`offscreen_npc_ids 引用不存在的 NPC #${off.npc_id}`);
		} else if (npc.status === "dead") {
			problems.push(`offscreen_npc_ids 含死者 NPC #${off.npc_id}`);
		}
	}
	const locations = new Set(storyDb.reader.listLocations().map((l) => l.name));
	if (!locations.has(card.scene_location_name)) {
		problems.push(`scene_location_name 未登记: ${JSON.stringify(card.scene_location_name)}`);
	}
	const clock = storyDb.reader.getClock();
	if (clock !== undefined && card.current_story_time !== clock.current_time) {
		problems.push(
			`current_story_time 与 clock 不一致: ${JSON.stringify(card.current_story_time)} != ${JSON.stringify(clock.current_time)}`,
		);
	}
	return problems;
}

/** 场景分析失败时的确定性兜底卡（M3 computeScenePlan 等价；离线名单留空，K 轮触发由 runtime 兜底）。 */
export function buildFallbackSceneCard(storyDb: StoryDb): SceneCard {
	const plan = computeScenePlan(storyDb, 0);
	const playerLoc = storyDb.reader.getPlayerLocation();
	const clock = storyDb.reader.getClock();
	return {
		onstage_npc_ids: plan.onstage.map((n) => n.id),
		offscreen_npc_ids: [],
		scene_location_name: playerLoc?.name ?? "",
		current_story_time: clock?.current_time ?? "",
		time_span_estimate: "",
		to_time_suggestion: "",
		scene_goal: "",
		tone: "",
		major_event: false,
	};
}

interface RecentNarrative {
	turnSeq: number;
	userInput: string;
	narrativeText: string;
}

function buildSceneUserPrompt(storyDb: StoryDb, input: { turnSeq: number; userInput: string; recentNarratives: RecentNarrative[] }): string {
	const parts: string[] = [];
	parts.push(`## 当前世界状态摘要（DB 权威事实，npc_id/地点名以此为准）\n${renderDbSummary(storyDb)}`);
	const npcs = storyDb.reader.listNpcs();
	parts.push(
		`## NPC 花名册（id 引用用）\n${npcs
			.map((n) => `- #${n.id} ${n.name}（status: ${n.status}，位置: ${n.current_location_name ?? "未定位"}）`)
			.join("\n") || "(无)"}`,
	);
	const locations = storyDb.reader.listLocations();
	parts.push(
		`## 地点注册表\n${locations.map((l) => `- ${l.name}${l.parent_name ? `（父: ${l.parent_name}）` : ""}`).join("\n") || "(无)"}`,
	);
	if (input.recentNarratives.length > 0) {
		parts.push(
			`## 近期叙事（供场景目标判断）\n${input.recentNarratives
				.map((r) => `--- turn ${r.turnSeq} ---\n玩家输入: ${r.userInput}\n叙事: ${r.narrativeText}`)
				.join("\n")}`,
		);
	}
	parts.push(`## 本轮玩家输入\n${input.userInput}`);
	const directives = storyDb.reader.listDirectives("active");
	if (directives.length > 0) {
		parts.push(`## 活跃指令（作者意图，必须纳入考量）\n${directives.map((d) => `- ${d.content}`).join("\n")}`);
	}
	parts.push(`## 指令\n${SCENE_INSTRUCTIONS}`);
	return parts.join("\n\n");
}

export interface SceneAnalysisResult {
	card: SceneCard;
	/** true = 场景分析失败降级为确定性兜底（不阻塞 pipeline）。 */
	fallback: boolean;
}

/** 场景分析（每轮最前）。重试耗尽 → 确定性兜底卡 + fallback:true + warning。 */
export async function runSceneAnalysis(
	input: { turnSeq: number; userInput: string; recentNarratives: RecentNarrative[] },
	opts: StoryStageOptions,
): Promise<SceneAnalysisResult> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = loadPrompt("story_scene", opts.prompts).content;
	let userPrompt = buildSceneUserPrompt(opts.storyDb, input);

	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "story_scene",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: SCENE_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = sceneCardZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else {
				const problems = validateSceneCard(opts.storyDb, parsed.data);
				if (problems.length > 0) {
					error = `第 ${attempt} 次提交未通过语义校验: ${problems.join("; ")}`;
				} else {
					opts.eventLog?.record({
						ts: new Date().toISOString(),
						turnSeq: input.turnSeq,
						role: "story_scene",
						ok: true,
						attempt,
						durationMs: Date.now() - attemptStartedAt,
						usage,
						inputChars: userPrompt.length,
						outputChars,
					});
					return { card: parsed.data, fallback: false };
				}
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		lastError = error;
		opts.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: input.turnSeq,
			role: "story_scene",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	console.warn(`[story_scene] 场景分析失败（${maxAttempts} 次重试耗尽），降级确定性兜底: ${lastError}`);
	return { card: buildFallbackSceneCard(opts.storyDb), fallback: true };
}

// ---------------------------------------------------------------------------
// 规则层确定性断言（每轮必跑，零 LLM）
// ---------------------------------------------------------------------------

export interface RuleCheckInput {
	sceneCard: SceneCard;
	storyDb: StoryDb;
	narrativeText: string;
	turnSeq: number;
}

export interface RuleCheckResult {
	/** 确定性硬冲突（场景卡本身自相矛盾/违背 DB 事实）——须打回或 strictDrop。 */
	hardConflicts: string[];
	/** 报疑（叙事文本层面，可能合法）——触发 LLM 审查层核验。 */
	suspicions: string[];
}

/**
 * 规则层断言集（M4 定案，逐条）：
 * 1. 硬冲突：场景卡在场 NPC status 为 dead/absent（死者/缺席者不得在场行动）。
 * 2. 硬冲突：在场 NPC 的 current_location ≠ 玩家位置（玩家已定位时；在场语义同 M3）。玩家未定位跳过。
 * 3. 硬冲突：在场名单 ∩ 离线名单 ≠ ∅（同一 NPC 不得同时在两地）。
 * 4. 硬冲突：场景卡 current_story_time ≠ clock.current_time（场景分析时间幻觉）。
 * 5. 报疑：叙事文本包含 status=dead NPC 的名字（可能合法追忆，交 LLM 层）。
 * 6. 报疑：叙事文本出现形如 YYYY-MM-DD 的日期且早于 clock.current_time（文本时间表述与数据不一致）。
 * 全部收集，不短路。
 */
export function runRuleChecks(input: RuleCheckInput): RuleCheckResult {
	const { sceneCard, storyDb, narrativeText } = input;
	const hardConflicts: string[] = [];
	const suspicions: string[] = [];

	const npcById = new Map(storyDb.reader.listNpcs().map((n) => [n.id, n]));
	const playerLoc = storyDb.reader.getPlayerLocation();
	const clock = storyDb.reader.getClock();

	// 1. 在场 NPC 不可为 dead/absent
	for (const id of sceneCard.onstage_npc_ids) {
		const npc = npcById.get(id);
		if (npc && (npc.status === "dead" || npc.status === "absent")) {
			hardConflicts.push(`场景卡在场 NPC #${id} ${npc.name} status=${npc.status}（死者/缺席者不得在场行动）`);
		}
	}
	// 2. 在场 NPC 当前位置必须等于玩家位置（玩家已定位时）
	if (playerLoc) {
		for (const id of sceneCard.onstage_npc_ids) {
			const npc = npcById.get(id);
			if (npc && npc.current_location !== playerLoc.id) {
				hardConflicts.push(
					`场景卡在场 NPC #${id} ${npc.name} 的 current_location=${npc.current_location_name ?? "null"} ≠ 玩家位置 ${playerLoc.name}`,
				);
			}
		}
	}
	// 3. 在场 ∩ 离线 = ∅
	const onstageSet = new Set(sceneCard.onstage_npc_ids);
	for (const off of sceneCard.offscreen_npc_ids) {
		if (onstageSet.has(off.npc_id)) {
			hardConflicts.push(`NPC #${off.npc_id} 同时出现在在场名单与离线名单`);
		}
	}
	// 4. 场景卡时间与 clock 一致
	if (clock !== undefined && sceneCard.current_story_time !== clock.current_time) {
		hardConflicts.push(
			`场景卡 current_story_time=${JSON.stringify(sceneCard.current_story_time)} ≠ clock=${JSON.stringify(clock.current_time)}（场景分析时间幻觉）`,
		);
	}
	// 5. 叙事含死者名字（报疑）
	for (const npc of npcById.values()) {
		if (npc.status === "dead" && narrativeText.includes(npc.name)) {
			suspicions.push(`叙事文本出现死者名字「${npc.name}」（可能合法追忆，交 LLM 层核验）`);
		}
	}
	// 6. 叙事含早于 clock 的日期（报疑）
	if (clock !== undefined) {
		for (const m of narrativeText.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
			if (m[0]! < clock.current_time) {
				suspicions.push(`叙事文本日期 ${m[0]} 早于当前故事时间 ${clock.current_time}`);
			}
		}
	}
	return { hardConflicts, suspicions };
}

// ---------------------------------------------------------------------------
// 审查（LLM 层，仅报疑时触发）
// ---------------------------------------------------------------------------

const REVIEW_INSTRUCTIONS = [
	"只查语义级硬矛盾：已知信息越界（NPC 知道不该知道的）、NPC OOC（言行与档案矛盾）、时间线矛盾、世界事实矛盾（与 DB 摘要冲突）。",
	"只报告确证冲突，不报风格问题，不误伤合理留白。",
	"findings 为空 = 通过。",
	"输出必须且只调用一次 submit_review 工具提交。",
].join("\n");

function buildReviewUserPrompt(
	storyDb: StoryDb,
	input: { turnSeq: number; narrativeText: string; suspicions: string[]; sceneCard: SceneCard },
): string {
	const parts: string[] = [];
	parts.push(`## 本轮叙事全文（审查对象）\n${input.narrativeText}`);
	parts.push(
		`## 规则层报疑清单（须逐条核实是否确证）\n${input.suspicions.length > 0 ? input.suspicions.map((s) => `- ${s}`).join("\n") : "(无)"}`,
	);
	parts.push(`## 场景卡\n${renderSceneCardForNarrator(input.sceneCard, storyDb)}`);
	const onstage = input.sceneCard.onstage_npc_ids
		.map((id) => storyDb.reader.getNpc(id))
		.filter((c) => c.npc !== undefined);
	parts.push(
		`## 在场 NPC 档案（OOC 判定用）\n${
			onstage.length === 0
				? "(无)"
				: onstage
						.map((c) => {
							const n = c.npc!;
							const traits = c.traits.map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
							const memories =
								[...c.memories]
									.sort((a, b) => b.salience - a.salience)
									.slice(0, 5)
									.map((m) => m.content)
									.join("；") || "(无)";
							return `#${n.id} ${n.name}（status: ${n.status}）特征[${traits}] 记忆[${memories}]`;
						})
						.join("\n")
		}`,
	);
	parts.push(`## 指令\n${REVIEW_INSTRUCTIONS}`);
	return parts.join("\n\n");
}

/** 审查（LLM 层）。zod 校验失败重试；耗尽 → 返回 [] + warning（审查失败放行，不阻塞）。 */
export async function runReview(
	input: { turnSeq: number; narrativeText: string; suspicions: string[]; sceneCard: SceneCard },
	opts: StoryStageOptions,
): Promise<ReviewFinding[]> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = loadPrompt("story_review", opts.prompts).content;
	let userPrompt = buildReviewUserPrompt(opts.storyDb, input);

	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "story_review",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: REVIEW_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = reviewZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else {
				opts.eventLog?.record({
					ts: new Date().toISOString(),
					turnSeq: input.turnSeq,
					role: "story_review",
					ok: true,
					attempt,
					durationMs: Date.now() - attemptStartedAt,
					usage,
					inputChars: userPrompt.length,
					outputChars,
				});
				return parsed.data.findings;
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		lastError = error;
		opts.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: input.turnSeq,
			role: "story_review",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	console.warn(`[story_review] 审查失败（${maxAttempts} 次重试耗尽），放行: ${lastError}`);
	return [];
}

// ---------------------------------------------------------------------------
// 全统筹（条件触发：每 K 轮或 major_event）
// ---------------------------------------------------------------------------

const OVERSEE_INSTRUCTIONS = [
	"评估节奏/伏笔回收/NPC 目标推进，产出给主叙事的约束与批注。",
	"suggestions 是该埋的钩子、下阶段建议。",
	"phase_advice：action=start 须给 name（可带 goals）；action=end 指当前 active 阶段；action=none 则其余字段可省。",
	"输出必须且只调用一次 submit_oversee 工具提交。",
].join("\n");

function buildOverseeUserPrompt(
	storyDb: StoryDb,
	input: { turnSeq: number; recentNarratives: RecentNarrative[]; sceneCard: SceneCard },
): string {
	const parts: string[] = [];
	parts.push(`## 当前世界状态摘要\n${renderDbSummary(storyDb)}`);
	parts.push(
		`## 近期叙事\n${input.recentNarratives
			.map((r) => `--- turn ${r.turnSeq} ---\n玩家输入: ${r.userInput}\n叙事: ${r.narrativeText}`)
			.join("\n")}`,
	);
	const phases = storyDb.reader.listPhases();
	parts.push(
		`## 阶段表\n${
			phases.length === 0
				? "(无)"
				: phases
						.map((p) => `- ${p.name}（status: ${p.status}，started_turn: ${p.started_turn}，ended_turn: ${p.ended_turn ?? "未结束"}${p.goals ? `，目标: ${p.goals}` : ""}）`)
						.join("\n")
		}`,
	);
	parts.push(`## 本轮场景卡\n${renderSceneCardForNarrator(input.sceneCard, storyDb)}`);
	parts.push(`## 指令\n${OVERSEE_INSTRUCTIONS}`);
	return parts.join("\n\n");
}

/** 全统筹（条件触发）。失败重试耗尽 → null + warning（不阻塞）。 */
export async function runOversee(
	input: { turnSeq: number; recentNarratives: RecentNarrative[]; sceneCard: SceneCard },
	opts: StoryStageOptions,
): Promise<OverseeNote | null> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = loadPrompt("story_oversee", opts.prompts).content;
	let userPrompt = buildOverseeUserPrompt(opts.storyDb, input);

	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "story_oversee",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: OVERSEE_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = overseeZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else {
				opts.eventLog?.record({
					ts: new Date().toISOString(),
					turnSeq: input.turnSeq,
					role: "story_oversee",
					ok: true,
					attempt,
					durationMs: Date.now() - attemptStartedAt,
					usage,
					inputChars: userPrompt.length,
					outputChars,
				});
				return parsed.data;
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		lastError = error;
		opts.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: input.turnSeq,
			role: "story_oversee",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	console.warn(`[story_oversee] 全统筹失败（${maxAttempts} 次重试耗尽），跳过: ${lastError}`);
	return null;
}

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------

/** 主叙事注入用场景卡（导演场景卡，玩家不可见）。 */
export function renderSceneCardForNarrator(card: SceneCard, storyDb: StoryDb): string {
	const nameById = new Map(storyDb.reader.listNpcs().map((n) => [n.id, n.name]));
	const lines: string[] = [];
	lines.push("以下为导演场景卡，玩家不可见；据此把握本轮目标、基调与在场人物：");
	lines.push(`场景地点: ${card.scene_location_name || "(未定位)"}`);
	lines.push(`当前故事时间: ${card.current_story_time || "(未知)"}`);
	lines.push(`本轮时间跨度估计: ${card.time_span_estimate || "(未估计)"}`);
	lines.push(`建议推进至: ${card.to_time_suggestion || "(未建议)"}`);
	lines.push(`场景目标: ${card.scene_goal || "(无)"}`);
	lines.push(`基调: ${card.tone || "(未指定)"}`);
	lines.push(
		`在场 NPC: ${card.onstage_npc_ids.length === 0 ? "(无)" : card.onstage_npc_ids.map((id) => `${nameById.get(id) ?? `#${id}`}#${id}`).join("、")}`,
	);
	if (card.offscreen_npc_ids.length > 0) {
		lines.push(
			`需离线推演: ${card.offscreen_npc_ids.map((o) => `${nameById.get(o.npc_id) ?? `#${o.npc_id}`}#${o.npc_id}（${o.reason}）`).join("、")}`,
		);
	}
	lines.push(`重大事件轮: ${card.major_event ? "是" : "否"}`);
	return lines.join("\n");
}

/** 全统筹批注（节奏/伏笔/建议/阶段建议）。 */
export function renderOverseeNote(note: OverseeNote): string {
	const lines: string[] = [];
	lines.push("以下为全统筹批注，玩家不可见；据此写作但不得暴露元叙述：");
	lines.push(`节奏: ${note.pacing}`);
	if (note.open_threads.length > 0) {
		lines.push("未收束伏笔:");
		lines.push(...note.open_threads.map((t) => `- ${t}`));
	}
	if (note.suggestions.length > 0) {
		lines.push("建议:");
		lines.push(...note.suggestions.map((s) => `- ${s}`));
	}
	if (note.phase_advice.action !== "none") {
		lines.push(
			note.phase_advice.action === "start"
				? `阶段建议: 开启「${note.phase_advice.name ?? "(缺名)"}」${note.phase_advice.goals ? `（目标: ${note.phase_advice.goals}）` : ""}`
				: "阶段建议: 结束当前 active 阶段",
		);
	}
	return lines.join("\n");
}

/** 打回批注（列出须修正的冲突：规则层硬冲突 + LLM 审查 findings）。 */
export function renderRevisionRequest(hardConflicts: string[], findings: ReviewFinding[]): string {
	const lines: string[] = [];
	lines.push("本轮叙事存在须修正的冲突，请按要求重写（玩家不可见此批注）：");
	for (const conflict of hardConflicts) lines.push(`- [硬冲突] ${conflict}`);
	for (const f of findings) lines.push(`- [${f.severity}] ${f.kind}: ${f.description}`);
	return lines.join("\n");
}
