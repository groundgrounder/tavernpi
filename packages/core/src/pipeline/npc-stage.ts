// npc subagent 纯模块层（创作规划 §6.2 两种模式 / 技术路线 §3.3；M3 过渡形态）。
//
// 两种模式：
//   1. 在场预演 ×N 并行（runOnstageRehearsals）：玩家所在位置的每个非 dead NPC 各起一个
//      inMemory session 预演意图/情绪/行动/台词/unaware_of + OOC 自检，产物注入主叙事（隐藏批注）。
//   2. 离线推演 ×1（runOffscreenBatch）：其余非 dead NPC 批量单次推演，delta 是**结构化产物**，
//      交 data subagent 转写落库（单写者规则不破，§6.1——npc 层永不直接写库）。
//
// M3 过渡形态说明：story 场景分析（§6.3）M4 才上线，故在场判定与离线触发器是**确定性**的：
//   在场 = current_location == 玩家当前 location_id（reader.getPlayerLocation）；玩家未定位 → 空在场。
//   离线触发 = world_state 键 sys_npc_offscreen_last_turn:<id> 距上次推演 ≥ N 轮（默认 5）；
//   时间跨度触发器需历法换算，M4 随 story 场景分析定案（此处注释留痕）。
//   「玩家进入其区域」触发在 M3 由在场判定自然覆盖（玩家到位即同地点在场）。
//
// 权威边界：离线 schema 结构上排除 status:"dead"（场外致死=背着玩家剧变）；提示词再禁止
// 「制造直接影响玩家的既成事实」——结构强制 + 提示词双保险（§6.2 权威边界）。
//
// 容错：单 NPC 预演失败（重试耗尽）→ 丢弃该批注（主叙事无该批注自由发挥），不抛、不阻塞；
// 离线批失败 → 返回 [] + warning 记录。eventLog 逐 attempt 记录 role=npc_onstage / npc_offscreen。

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { TSchema } from "typebox";
import type { StoryDb } from "../db/story-db.ts";
import type { NpcRow } from "../db/types.ts";
import { loadPrompt, renderPlaceholders, type PromptLayerDirs } from "../prompts/loader.ts";
import {
	runSubagent,
	type SubagentOutputTool,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "../subagent/runtime.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";

// ---------------------------------------------------------------------------
// 在场预演 schema（token 预算机械强制——M3 定案值）
// ---------------------------------------------------------------------------

const rehearsalSchema = z.object({
	npc_id: z.number().int().positive(),
	intent: z.string().max(120), // 意图
	mood: z.string().max(40), // 情绪
	action_points: z.array(z.string().max(80)).max(5), // 下一步行动要点（bullet）
	dialogue_cues: z.array(z.string().max(100)).max(3), // 台词线索（bullet，非散文）
	unaware_of: z.array(z.string().max(80)).max(3), // 它不知道的事（无上帝视角约束）
	ooc_check: z.object({
		passed: z.boolean(),
		risks: z.string().max(200).optional(),
		revised_action_points: z.array(z.string().max(80)).max(5).optional(),
		revised_dialogue_cues: z.array(z.string().max(100)).max(3).optional(),
	}),
});

export const rehearsalZodSchema = rehearsalSchema;
export type NpcRehearsal = z.infer<typeof rehearsalZodSchema>;

/** JSON Schema 产物（接入 runSubagent 输出工具的 constrainedSampling）。 */
export const REHEARSAL_JSON_SCHEMA = rehearsalSchema.toJSONSchema() as unknown as TSchema;

// ---------------------------------------------------------------------------
// 离线推演 schema（权威边界结构强制）
// ---------------------------------------------------------------------------

const offscreenDeltaSchema = z.object({
	npc_id: z.number().int().positive(),
	location_name: z.string().max(60).optional(), // 移动目标（须已登记）
	activity: z.string().max(120), // 在做的事
	memories: z
		.array(
			z.object({
				kind: z.string().max(20),
				content: z.string().max(120),
				salience: z.number().min(0).max(1).optional(),
			}),
		)
		.max(3)
		.optional(),
	status: z.enum(["alive", "absent"]).optional(), // ← 结构排除 dead：场外致死=背着玩家剧变（§6.2 权威边界）
	relations: z
		.array(
			z.object({
				other_npc_id: z.number().int().positive(),
				disposition: z.number().int().min(-100).max(100),
			}),
		)
		.max(2)
		.optional(),
});

const offscreenSchema = z.object({
	deltas: z.array(offscreenDeltaSchema).max(12),
});

export const offscreenZodSchema = offscreenSchema;
export type OffscreenDelta = z.infer<typeof offscreenDeltaSchema>;
export type OffscreenBatch = z.infer<typeof offscreenSchema>;

/** JSON Schema 产物（接入 runSubagent 输出工具的 constrainedSampling）。 */
export const OFFSCREEN_JSON_SCHEMA = offscreenSchema.toJSONSchema() as unknown as TSchema;

// ---------------------------------------------------------------------------
// 确定性场景规划（M3 过渡形态；story 场景分析 M4 接管）
// ---------------------------------------------------------------------------

/** 内核簿记键前缀（编排器维护，data 禁写，见 changeset.isReservedWorldStateKey）。 */
export const OFFSCREEN_LAST_TURN_PREFIX = "sys_npc_offscreen_last_turn:";

/** 离线推演 last-turn 簿记键（world_state）。 */
export function offscreenLastTurnKey(npcId: number): string {
	return `${OFFSCREEN_LAST_TURN_PREFIX}${npcId}`;
}

export interface ScenePlan {
	/** 在场 NPC（玩家当前位置同地点，status ≠ dead）。玩家未定位 → 空。 */
	onstage: NpcRow[];
	/** 触发离线推演的 NPC（非 dead 且距上次推演 ≥ offscreenAfterTurns 轮）。 */
	offscreenTriggered: NpcRow[];
}

/**
 * 确定性场景规划：在场 = 同地点；离线触发 = last-turn 簿记键（缺省 0）距今 ≥ N 轮。
 * status='dead' 永不在场也不推演。
 */
export function computeScenePlan(
	storyDb: StoryDb,
	turnSeq: number,
	opts: { offscreenAfterTurns?: number } = {},
): ScenePlan {
	const offscreenAfterTurns = opts.offscreenAfterTurns ?? 5;
	const playerLoc = storyDb.reader.getPlayerLocation();
	const playerLocationId = playerLoc?.id ?? null;
	const worldState = new Map(storyDb.reader.listWorldState().map((w) => [w.key, w.value]));

	const onstage: NpcRow[] = [];
	const offscreenTriggered: NpcRow[] = [];
	for (const npc of storyDb.reader.listNpcs()) {
		if (npc.status === "dead") continue;
		if (playerLocationId !== null && npc.current_location === playerLocationId) {
			onstage.push(npc);
			continue;
		}
		const lastTurnRaw = worldState.get(offscreenLastTurnKey(npc.id));
		const lastTurn = lastTurnRaw === undefined ? 0 : Number(lastTurnRaw);
		if (Number.isInteger(lastTurn) && lastTurn >= 0 && turnSeq - lastTurn >= offscreenAfterTurns) {
			offscreenTriggered.push(npc);
		}
	}
	return { onstage, offscreenTriggered };
}

// ---------------------------------------------------------------------------
// 输出工具与任务指令
// ---------------------------------------------------------------------------

export const ONSTAGE_OUTPUT_TOOL_NAME = "submit_rehearsal";
export const OFFSCREEN_OUTPUT_TOOL_NAME = "submit_offscreen_deltas";

const REHEARSAL_TOOL: SubagentOutputTool = {
	name: ONSTAGE_OUTPUT_TOOL_NAME,
	description: "提交该 NPC 的行为预演（唯一输出通道）。必须且只调用一次，npc_id 必须等于你负责的 NPC。",
	schema: REHEARSAL_JSON_SCHEMA,
};

const OFFSCREEN_TOOL: SubagentOutputTool = {
	name: OFFSCREEN_OUTPUT_TOOL_NAME,
	description: "提交本次离线推演的 deltas（唯一输出通道）。必须且只调用一次。",
	schema: OFFSCREEN_JSON_SCHEMA,
};

export interface NpcStageOptions {
	storyDb: StoryDb;
	cwd: string;
	model?: SubagentRunOptions["model"];
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	/** 每 NPC/每批重试上限（默认 2）。 */
	maxAttempts?: number;
	/** 缺省 runSubagent；测试/验收故障注入通道。 */
	executor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
}

const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

const REHEARSAL_INSTRUCTIONS = [
	"以该 NPC 的视角预演：严格依据其特征/记忆/关系，不得违背既有设定。",
	"行动要点与台词线索用简短 bullet，非散文。",
	"unaware_of 必填它此刻不应知道的事（玩家内心、未目击事件、离线他处发生的事）——无上帝视角。",
	"OOC 自检必经：对照特征与记忆检查拟议行动/台词，有风险则 ooc_check.passed=false 并给出 risks 与修正版。",
	"输出必须且只调用一次 submit_rehearsal 工具提交。",
].join("\n");

const OFFSCREEN_INSTRUCTIONS = [
	"只演化 NPC 自身（位置/活动/记忆/关系/alive↔absent）。",
	"禁止：致死任何 NPC；制造直接影响玩家的既成事实（火灾/死亡/物品失窃等玩家将面对的变化）；引入玩家相关事件。",
	"推演须与性格/记忆/所在地点连贯，时间跨度与距上次推演轮数匹配。",
	"不必每个 NPC 都产出（无变化可省略 delta）。",
	"输出必须且只调用一次 submit_offscreen_deltas 工具提交。",
].join("\n");

// ---------------------------------------------------------------------------
// 提示词组装
// ---------------------------------------------------------------------------

/** 单个在场 NPC 的预演 userPrompt：档案 + 场景上下文 + 玩家输入 + 任务指令。 */
function buildRehearsalUserPrompt(storyDb: StoryDb, npc: NpcRow, turnSeq: number, userInput: string): string {
	const composite = storyDb.reader.getNpc(npc.id);
	const traitsText = composite.traits.map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
	const memoriesText =
		[...composite.memories]
			.sort((a, b) => b.salience - a.salience)
			.slice(0, 5)
			.map((m) => `${m.content}（salience ${m.salience}）`)
			.join("；") || "(无)";
	const relationsText =
		composite.relations
			.map((r) => `与 #${r.npc_a === npc.id ? r.npc_b : r.npc_a} 好感 ${r.disposition}`)
			.join("；") || "(无)";
	const parts: string[] = [];
	parts.push(
		`## 角色档案\nNPC #${npc.id} ${npc.name}（status: ${npc.status}，位置: ${npc.current_location_name ?? "未定位"}）`,
	);
	parts.push(`特征[${traitsText}]`);
	parts.push(`记忆[${memoriesText}]`);
	parts.push(`关系[${relationsText}]`);
	parts.push(`## 场景上下文（turn ${turnSeq}）\n${renderDbSummary(storyDb, { recentEvents: 5 })}`);
	parts.push(`## 本轮玩家输入\n${userInput}`);
	parts.push(`## 指令\n${REHEARSAL_INSTRUCTIONS}`);
	return parts.join("\n\n");
}

/** 离线批量 userPrompt：当前时间 + 各 NPC 紧凑档案（按所在地点分组，含距上次推演轮数）+ 任务指令。 */
function buildOffscreenUserPrompt(storyDb: StoryDb, npcs: NpcRow[], turnSeq: number): string {
	const clock = storyDb.reader.getClock();
	const worldState = new Map(storyDb.reader.listWorldState().map((w) => [w.key, w.value]));
	const lines: string[] = [];
	lines.push(
		`## 当前故事时间\n${clock ? `${clock.current_time}（历法 ${clock.calendar}，粒度 ${clock.granularity}）` : "(未初始化)"}`,
	);
	lines.push(`## 离线推演对象（本次 ${npcs.length} 个 NPC）`);
	const byLocation = new Map<string | null, NpcRow[]>();
	for (const npc of npcs) {
		const key = npc.current_location_name ?? null;
		const list = byLocation.get(key) ?? [];
		list.push(npc);
		byLocation.set(key, list);
	}
	for (const [location, list] of byLocation) {
		lines.push(location ? `【${location}】` : "【位置未定位】");
		for (const npc of list) {
			const composite = storyDb.reader.getNpc(npc.id);
			const traitsText = composite.traits.slice(0, 3).map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
			const memoriesText =
				[...composite.memories]
					.sort((a, b) => b.salience - a.salience)
					.slice(0, 3)
					.map((m) => m.content)
					.join("；") || "(无)";
			const lastTurnRaw = worldState.get(offscreenLastTurnKey(npc.id));
			const lastTurn = lastTurnRaw === undefined ? 0 : Number(lastTurnRaw);
			lines.push(
				`- #${npc.id} ${npc.name}（status: ${npc.status}，距上次推演 ${turnSeq - lastTurn} 轮）特征[${traitsText}] 记忆[${memoriesText}]`,
			);
		}
	}
	lines.push(`## 指令\n${OFFSCREEN_INSTRUCTIONS}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 在场预演（×N 并行）
// ---------------------------------------------------------------------------

/** 单 NPC 预演（内部重试循环）。失败（重试耗尽）→ null（丢弃，不阻塞 pipeline）。 */
async function runOneRehearsal(
	npc: NpcRow,
	turnSeq: number,
	userInput: string,
	opts: NpcStageOptions & { maxAttempts: number; executor: NpcStageOptions["executor"] },
	eventLog: PipelineEventLog | undefined,
): Promise<NpcRehearsal | null> {
	const systemPrompt = renderPlaceholders(loadPrompt("npc_onstage", opts.prompts).content, {
		npc_name: npc.name,
	}).text;
	let userPrompt = buildRehearsalUserPrompt(opts.storyDb, npc, turnSeq, userInput);

	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await opts.executor!({
				role: "npc_onstage",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: REHEARSAL_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = rehearsalZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else if (parsed.data.npc_id !== npc.id) {
				// 防串台：预演必须属于请求的 NPC
				error = `第 ${attempt} 次提交 npc_id 串台: 请求 #${npc.id}，收到 #${parsed.data.npc_id}`;
			} else {
				eventLog?.record({
					ts: new Date().toISOString(),
					turnSeq,
					role: "npc_onstage",
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
		eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq,
			role: "npc_onstage",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		// 校验反馈进下次 attempt（模型自纠通道）
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	return null;
}

/**
 * 在场预演：每个在场 NPC 一路独立 subagent，Promise.all 并行（全部 settle）。
 * 失败的 NPC 被丢弃（降级），不抛——单 NPC 失败不阻塞 pipeline（主叙事无该批注自由发挥）。
 */
export async function runOnstageRehearsals(
	npcs: NpcRow[],
	turnSeq: number,
	userInput: string,
	opts: NpcStageOptions,
): Promise<NpcRehearsal[]> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const results = await Promise.all(
		npcs.map((npc) => runOneRehearsal(npc, turnSeq, userInput, { ...opts, maxAttempts, executor }, opts.eventLog)),
	);
	return results.filter((r): r is NpcRehearsal => r !== null);
}

// ---------------------------------------------------------------------------
// 离线批量推演（×1）
// ---------------------------------------------------------------------------

/** 离线 delta 语义校验：npc_id ∈ 输入名单、location_name 已登记、other_npc_id 存在。 */
function validateOffscreenDeltas(storyDb: StoryDb, npcs: NpcRow[], deltas: OffscreenDelta[]): string[] {
	const problems: string[] = [];
	const allowedIds = new Set(npcs.map((n) => n.id));
	const registeredLocations = new Set(storyDb.reader.listLocations().map((l) => l.name));
	const allNpcs = new Set(storyDb.reader.listNpcs().map((n) => n.id));
	for (const delta of deltas) {
		if (!allowedIds.has(delta.npc_id)) {
			problems.push(`delta.npc_id #${delta.npc_id} 不在本次离线推演名单`);
		}
		if (delta.location_name !== undefined && !registeredLocations.has(delta.location_name)) {
			problems.push(`delta.location_name 未登记: ${JSON.stringify(delta.location_name)}`);
		}
		for (const rel of delta.relations ?? []) {
			if (!allNpcs.has(rel.other_npc_id)) {
				problems.push(`delta.relations.other_npc_id 不存在: #${rel.other_npc_id}`);
			}
		}
	}
	return problems;
}

/**
 * 离线批量推演（单 session）。失败（重试耗尽）→ 返回 [] + warning 记录，不抛。
 */
export async function runOffscreenBatch(npcs: NpcRow[], turnSeq: number, opts: NpcStageOptions): Promise<OffscreenDelta[]> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = loadPrompt("npc_offscreen", opts.prompts).content;
	let userPrompt = buildOffscreenUserPrompt(opts.storyDb, npcs, turnSeq);

	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "npc_offscreen",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: OFFSCREEN_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = offscreenZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else {
				const problems = validateOffscreenDeltas(opts.storyDb, npcs, parsed.data.deltas);
				if (problems.length > 0) {
					error = `第 ${attempt} 次提交未通过语义校验: ${problems.join("; ")}`;
				} else {
					eventLogRecord(opts.eventLog, turnSeq, attempt, attemptStartedAt, userPrompt, outputChars, usage, true);
					return parsed.data.deltas;
				}
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		lastError = error;
		eventLogRecord(opts.eventLog, turnSeq, attempt, attemptStartedAt, userPrompt, outputChars, usage, false, error);
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	console.warn(`[npc_offscreen] 离线批量推演失败（${maxAttempts} 次重试耗尽，已丢弃本轮 deltas）: ${lastError}`);
	return [];
}

/** eventLog 记录（role 由调用方场景决定，此处固定 npc_offscreen）。 */
function eventLogRecord(
	eventLog: PipelineEventLog | undefined,
	turnSeq: number,
	attempt: number,
	attemptStartedAt: number,
	userPrompt: string,
	outputChars: number | undefined,
	usage: SubagentUsage,
	ok: boolean,
	error?: string,
): void {
	eventLog?.record({
		ts: new Date().toISOString(),
		turnSeq,
		role: "npc_offscreen",
		ok,
		attempt,
		durationMs: Date.now() - attemptStartedAt,
		usage,
		inputChars: userPrompt.length,
		outputChars,
		error,
	});
}

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------

/** 主叙事注入用隐藏批注（NPC 内心与预谋，玩家不可见）。OOC 未过时用修正版并标注。 */
export function renderRehearsals(rehearsals: NpcRehearsal[], storyDb: StoryDb): string {
	const nameById = new Map(storyDb.reader.listNpcs().map((n) => [n.id, n.name]));
	const lines: string[] = [];
	lines.push("以下为导演批注（NPC 内心与预谋），玩家不可见；据此写作但不得暴露元叙述：");
	for (const r of rehearsals) {
		const name = nameById.get(r.npc_id) ?? `#${r.npc_id}`;
		const oocPassed = r.ooc_check.passed;
		const actionPoints = oocPassed ? r.action_points : (r.ooc_check.revised_action_points ?? r.action_points);
		const dialogueCues = oocPassed ? r.dialogue_cues : (r.ooc_check.revised_dialogue_cues ?? r.dialogue_cues);
		lines.push(`【${name}#${r.npc_id}】`);
		lines.push(`意图: ${r.intent}`);
		lines.push(`情绪: ${r.mood}`);
		lines.push("行动要点:");
		lines.push(...actionPoints.map((a) => `- ${a}`));
		lines.push("台词线索:");
		lines.push(...dialogueCues.map((c) => `- ${c}`));
		lines.push("它不知道的事:");
		lines.push(...r.unaware_of.map((u) => `- ${u}`));
		if (!oocPassed) {
			lines.push(`（已按 OOC 自检修正${r.ooc_check.risks ? `：${r.ooc_check.risks}` : ""}）`);
		}
	}
	return lines.join("\n");
}

/** data 输入用：离线 delta 转写指示（data 是唯一写者，npc 层产物须经 data 落库）。 */
export function renderOffscreenDeltasForData(deltas: OffscreenDelta[], storyDb: StoryDb): string {
	const nameById = new Map(storyDb.reader.listNpcs().map((n) => [n.id, n.name]));
	const lines: string[] = [];
	lines.push(
		"以下为本轮离线 NPC 推演的结构化产物，须转写进变更集落库（位置变化走 location_moves subject 'npc:<id>'，记忆/状态/关系走 npc_updates）：",
	);
	for (const delta of deltas) {
		const name = nameById.get(delta.npc_id) ?? `#${delta.npc_id}`;
		const parts = [`#${delta.npc_id} ${name}`, `活动: ${delta.activity}`];
		if (delta.location_name !== undefined) parts.push(`移动目标: ${delta.location_name}`);
		if (delta.status !== undefined) parts.push(`状态: ${delta.status}`);
		if (delta.memories !== undefined && delta.memories.length > 0) {
			parts.push(`新增记忆: ${delta.memories.map((m) => `${m.kind}: ${m.content}`).join("；")}`);
		}
		if (delta.relations !== undefined && delta.relations.length > 0) {
			parts.push(`关系: ${delta.relations.map((r) => `与 #${r.other_npc_id} 好感 ${r.disposition}`).join("；")}`);
		}
		lines.push(`- ${parts.join("；")}`);
	}
	return lines.join("\n");
}
