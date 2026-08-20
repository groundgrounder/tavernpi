// data subagent 编排（§6.1 data 是唯一写者）：每轮叙事定稿后从文本抽取状态变更并落库。
// 流程：DB 摘要 + 当前轮 + 待补齐轮（pendingTurns）组装 userPrompt → 经 P1 runSubagent 单输出
// 工具强制结构化输出（submit_changeset）→ zod safeParse → applyChangeset（校验+原子应用）。
// 失败路径（§6.1）：重试上限内把「第 N 次提交未通过校验/应用」反馈追加进下次 attempt 的
// userPrompt（模型自纠）；executor 抛错同样进重试；耗尽返回 ok:false（快照跳过由上层处理）。
// 每次 attempt 记 eventLog（role:"data"）。

import { loadPrompt, type PromptLayerDirs } from "../prompts/loader.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StoryDb } from "../db/story-db.ts";
import { runSubagent, type SubagentOutputTool, type SubagentResult, type SubagentRunOptions, type SubagentUsage } from "../subagent/runtime.ts";
import type { PipelineEventLog } from "./events.ts";
import { renderDbSummary } from "./db-summary.ts";
import { applyChangeset, changesetZodSchema, CHANGELOG_JSON_SCHEMA, type ApplySummary } from "./changeset.ts";

/** data subagent 的输出工具名（唯一白名单工具；constrainedSampling 强制 JSON 结构输出）。 */
export const DATA_OUTPUT_TOOL_NAME = "submit_changeset";

const OUTPUT_TOOL: SubagentOutputTool = {
	name: DATA_OUTPUT_TOOL_NAME,
	description:
		"把本轮（含待补齐轮次）叙事文本中明确发生的世界状态变更作为完整变更集提交。必须且只调用一次。",
	schema: CHANGELOG_JSON_SCHEMA,
};

export interface DataStageInput {
	turnSeq: number;
	userInput: string;
	narrativeText: string;
	createdEntryId?: string;
	/** data 失败待补齐轮（§6.1）：事实尚未入 DB，须一并抽取进本次变更集。 */
	pendingTurns: Array<{ turnSeq: number; userInput: string; narrativeText: string }>;
}

export interface DataStageOptions {
	storyDb: StoryDb;
	input: DataStageInput;
	cwd: string;
	model?: SubagentRunOptions["model"];
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	/** 重试上限（默认 3）。 */
	maxAttempts?: number;
	/** 缺省 runSubagent；测试/验收故障注入通道。 */
	executor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
}

export type DataStageOutcome =
	| { ok: true; attempts: number; applied: ApplySummary; usage: SubagentUsage; durationMs: number }
	| { ok: false; attempts: number; error: string; durationMs: number };

const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

/** 任务指令（随 userPrompt 注入，与 data.md 互补；schema 字段语义见 changeset.ts）。 */
const TASK_INSTRUCTIONS = [
	"输出必须且只调用一次 submit_changeset 工具提交。",
	"引用已存在的 NPC 用本摘要里的 npc_id，不要用名字或编造 id。",
	"新人物先进 new_npcs（下轮起才可经 npc_updates 用 npc_id 引用）。",
	"新地点先进 new_locations 再引用（events/location_moves/new_npcs 的地点名必须已登记或同集内登记）。",
	"时间每轮必推进（time_advance 必填），to_time 不早于当前故事时间，同日小跨度保持同日期并用 span_note 说明时段。",
	"玩家移动用 location_moves subject='player'；world_state 禁止写 player_location。",
	"只抽取文本中明确发生的事实，不推测、不脑补、不重复已落库内容。",
].join("\n");

function buildUserPrompt(storyDb: StoryDb, input: DataStageInput): string {
	const parts: string[] = [];
	parts.push(`## 当前世界状态摘要（DB 权威事实，npc_id/地点名以此为准）\n${renderDbSummary(storyDb)}`);
	parts.push(`## 任务\nturn_seq = ${input.turnSeq}。从下面叙事文本中抽取本轮的世界状态变更。`);
	parts.push(`## 玩家输入\n${input.userInput}`);
	parts.push(`## 本轮叙事文本（抽取对象）\n${input.narrativeText}`);
	if (input.pendingTurns.length > 0) {
		parts.push(
			[
				`## 待补齐轮次（此前 ${input.pendingTurns.length} 轮 data 落库失败，其事实尚未入 DB，必须一并抽取进本次变更集）`,
				...input.pendingTurns.map(
					(p) => `--- turn ${p.turnSeq} ---\n玩家输入: ${p.userInput}\n叙事文本: ${p.narrativeText}`,
				),
			].join("\n"),
		);
	}
	parts.push(`## 指令\n${TASK_INSTRUCTIONS}`);
	return parts.join("\n\n");
}

/** 跑一轮 data 阶段（重试循环）。不抛错：所有失败路径收敛为 ok:false 返回值。 */
export async function runDataStage(opts: DataStageOptions): Promise<DataStageOutcome> {
	const { storyDb, input, cwd, eventLog } = opts;
	const maxAttempts = opts.maxAttempts ?? 3;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = loadPrompt("data", opts.prompts).content;
	const startedAt = Date.now();
	let userPrompt = buildUserPrompt(storyDb, input);

	let lastError = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "data",
				cwd,
				systemPrompt,
				userPrompt,
				outputTool: OUTPUT_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;

			const parsed = changesetZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else {
				try {
					const applied = applyChangeset(storyDb, parsed.data, {
						turnSeq: input.turnSeq,
						createdEntryId: input.createdEntryId,
					});
					eventLog?.record({
						ts: new Date().toISOString(),
						turnSeq: input.turnSeq,
						role: "data",
						ok: true,
						attempt,
						durationMs: Date.now() - attemptStartedAt,
						usage,
						inputChars: userPrompt.length,
						outputChars,
					});
					return { ok: true, attempts: attempt, applied, usage, durationMs: Date.now() - startedAt };
				} catch (applyErr) {
					error = `第 ${attempt} 次提交未通过语义校验/应用: ${applyErr instanceof Error ? applyErr.message : String(applyErr)}`;
				}
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		lastError = error;
		eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: input.turnSeq,
			role: "data",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		// 校验反馈进下次 attempt 的 userPrompt（模型自纠通道，§6.1 重试机制）
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	return { ok: false, attempts: maxAttempts, error: lastError, durationMs: Date.now() - startedAt };
}
