// stylize 纯模块层（创作规划 §6.4；M4 纯模块形态）。
//
// 默认关闭的可选阶段；只改文风不动事实；时机 = 审查通过后、data 前（主叙事正文定稿后）。
// 零事实漂移 = 提示词硬约束 + 规则层实体/数值抽查双保险（stylizeFactCheck）：
//   ① 数字多重集合（含日期数字）；② DB 实体名出现向量（原文出现的改写后必须仍在、
//   原文未出现的不得新增）；③ 篇幅比 >1.8 记 drift「篇幅膨胀」。
// 失败回退原文（applied=false）——turn_log.raw_text 已留痕 stylize 前原文（§6.4 语义）。
// eventLog 逐 attempt 记录 role=stylize；不阻塞 pipeline。

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { TSchema } from "typebox";
import type { StoryDb } from "../db/story-db.ts";
import { loadPrompt, renderPlaceholders, type PromptLayerDirs } from "../prompts/loader.ts";
import {
	runSubagent,
	type SubagentOutputTool,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "../subagent/runtime.ts";
import type { PipelineEventLog } from "./events.ts";

const stylizeOutputSchema = z.object({
	text: z.string().min(1), // 无 maxLength——长度约束走 prompt 层「不超过原文 1.5 倍」
});

export const stylizeZodSchema = stylizeOutputSchema;
export type StylizeOutput = z.infer<typeof stylizeOutputSchema>;
export const STYLIZE_JSON_SCHEMA = stylizeOutputSchema.toJSONSchema() as unknown as TSchema;

export const STYLIZE_OUTPUT_TOOL_NAME = "submit_stylized";

const STYLIZE_TOOL: SubagentOutputTool = {
	name: STYLIZE_OUTPUT_TOOL_NAME,
	description: "提交润色后的正文（唯一输出通道）。必须且只调用一次。",
	schema: STYLIZE_JSON_SCHEMA,
};

export interface StylizeOptions {
	cwd: string;
	model?: SubagentRunOptions["model"];
	modelRuntime?: ModelRuntime;
	prompts?: PromptLayerDirs;
	eventLog?: PipelineEventLog;
	/** 重试上限（默认 2）。 */
	maxAttempts?: number;
	/** 缺省 runSubagent；测试/验收故障注入通道。 */
	executor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
}

const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

const STYLIZE_INSTRUCTIONS = [
	"零事实漂移：事件、对白语义、时间、数值、实体名与改写前完全一致。",
	"只改用词/句式/节奏/视角一致性。",
	"篇幅不超过原文 1.5 倍。",
	"输出必须且只调用一次 submit_stylized 工具提交。",
].join("\n");

/** {{style_hint}} 为空时的默认文风表述（stylize.md 模板的占位符注入值）。 */
const DEFAULT_STYLE_HINT =
	"保持当前默认文风：中文叙事散文，第三人称限制视角（跟随玩家角色），现在时态，篇幅不超过原文 1.5 倍。";

/**
 * 零事实漂移抽查（纯函数）：数字多重集合 / DB 实体名出现向量 / 篇幅比。
 * ② 的实体集合 = npcs.name ∪ locations.name（单字/短名误报由调用侧提示词自纠兜底）。
 */
export function stylizeFactCheck(original: string, rewritten: string, storyDb: StoryDb): { ok: boolean; drift: string[] } {
	const drift: string[] = [];

	// ① 数字多重集合（含日期数字；排序后逐位比对）
	const numbersOf = (s: string): string => (s.match(/\d+/g) ?? []).slice().sort().join(",");
	if (numbersOf(original) !== numbersOf(rewritten)) {
		drift.push(`数字集合不一致（原文 [${numbersOf(original)}] vs 改写 [${numbersOf(rewritten)}]）`);
	}

	// ② DB 实体名出现向量
	const entityNames = [...storyDb.reader.listNpcs().map((n) => n.name), ...storyDb.reader.listLocations().map((l) => l.name)];
	for (const name of entityNames) {
		const inOriginal = original.includes(name);
		const inRewritten = rewritten.includes(name);
		if (inOriginal && !inRewritten) {
			drift.push(`实体名「${name}」在改写后消失`);
		} else if (!inOriginal && inRewritten) {
			drift.push(`改写后新增原文未出现的实体名「${name}」`);
		}
	}

	// ③ 篇幅比
	const ratio = rewritten.length / Math.max(1, original.length);
	if (ratio > 1.8) {
		drift.push(`篇幅膨胀（${rewritten.length}/${original.length}=${ratio.toFixed(2)} > 1.8）`);
	}

	return { ok: drift.length === 0, drift };
}

/**
 * 润色（默认关闭的可选阶段）。失败（重试耗尽，含事实漂移）→ applied=false 回退原文 + drift/warning。
 */
export async function runStylize(
	input: { turnSeq: number; narrativeText: string; styleHint?: string },
	opts: StylizeOptions & { storyDb: StoryDb },
): Promise<{ text: string; applied: boolean; drift?: string[] }> {
	const maxAttempts = opts.maxAttempts ?? 2;
	const executor = opts.executor ?? runSubagent;
	const systemPrompt = renderPlaceholders(loadPrompt("stylize", opts.prompts).content, {
		style_hint: input.styleHint?.trim() ? input.styleHint.trim() : DEFAULT_STYLE_HINT,
	}).text;
	let userPrompt = [`## 待润色原文（不得改变任何事实）\n${input.narrativeText}`, `## 指令\n${STYLIZE_INSTRUCTIONS}`].join(
		"\n\n",
	);

	let lastError = "";
	let lastDrift: string[] | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const attemptStartedAt = Date.now();
		let usage: SubagentUsage = ZERO_USAGE;
		let outputChars: number | undefined;
		let error: string | undefined;
		try {
			const result = await executor({
				role: "stylize",
				cwd: opts.cwd,
				systemPrompt,
				userPrompt,
				outputTool: STYLIZE_TOOL,
				model: opts.model,
				modelRuntime: opts.modelRuntime,
			});
			usage = result.usage;
			outputChars = JSON.stringify(result.output).length;
			const parsed = stylizeZodSchema.safeParse(result.output);
			if (!parsed.success) {
				error = `第 ${attempt} 次提交未通过 schema 校验: ${parsed.error.issues
					.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
					.join("; ")}`;
			} else {
				const fact = stylizeFactCheck(input.narrativeText, parsed.data.text, opts.storyDb);
				if (fact.ok) {
					opts.eventLog?.record({
						ts: new Date().toISOString(),
						turnSeq: input.turnSeq,
						role: "stylize",
						ok: true,
						attempt,
						durationMs: Date.now() - attemptStartedAt,
						usage,
						inputChars: userPrompt.length,
						outputChars,
					});
					return { text: parsed.data.text, applied: true };
				}
				lastDrift = fact.drift;
				error = `第 ${attempt} 次提交未通过零漂移抽查: ${fact.drift.join("; ")}`;
			}
		} catch (err) {
			error = `第 ${attempt} 次执行失败: ${err instanceof Error ? err.message : String(err)}`;
		}
		lastError = error;
		opts.eventLog?.record({
			ts: new Date().toISOString(),
			turnSeq: input.turnSeq,
			role: "stylize",
			ok: false,
			attempt,
			durationMs: Date.now() - attemptStartedAt,
			usage,
			inputChars: userPrompt.length,
			outputChars,
			error,
		});
		// 事实漂移反馈进下次 attempt（模型自纠通道）
		userPrompt += `\n\n## 上次提交失败反馈（必须修正后重新提交）\n${error}`;
	}
	console.warn(`[stylize] 润色失败（${maxAttempts} 次重试耗尽），回退原文: ${lastError}`);
	return { text: input.narrativeText, applied: false, drift: lastDrift };
}
