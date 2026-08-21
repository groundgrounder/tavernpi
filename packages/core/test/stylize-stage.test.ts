// stylize 纯模块层单测（§6.4；stub executor 无 LLM）：零事实漂移抽查（数字/实体/篇幅）、
// runStylize 成功/自纠/回退原文。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import type { SubagentResult, SubagentRunOptions, SubagentUsage } from "../src/subagent/runtime.ts";
import { createPipelineEventLog, type PipelineEvent } from "../src/pipeline/events.ts";
import { runStylize, stylizeFactCheck } from "../src/pipeline/stylize-stage.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function openTempStory(dir: string): StoryDb {
	return openStoryDb(join(dir, "story.db"));
}

function seedStylizeStory(story: StoryDb): void {
	story.writer.insertLocation({ name: "王城" });
	story.writer.insertLocation({ name: "市集" });
	story.writer.insertNpc({ name: "艾琳" });
	story.writer.insertNpc({ name: "贝罗" });
}

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

// ---------------------------------------------------------------------------
// stylizeFactCheck
// ---------------------------------------------------------------------------

	test("stylizeFactCheck：通过路径（数字/实体名一致、篇幅未膨胀）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		const originalAr = "艾琳在王城给了贝罗 3 枚铜币，说要买 5 尺布。";
		const rewrittenAr = "王城之中，艾琳将 3 枚铜币递给贝罗，称要买 5 尺布。";
		const result = stylizeFactCheck(originalAr, rewrittenAr, story);
		assert.equal(result.ok, true);
		assert.deepEqual(result.drift, []);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("stylizeFactCheck：数字集合不一致 → drift", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		const result = stylizeFactCheck("他付了 3 枚铜币。", "他付了 4 枚铜币。", story);
		assert.equal(result.ok, false);
		assert.ok(result.drift.some((d) => d.includes("数字集合不一致")));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("stylizeFactCheck：实体名消失 / 新增 → drift", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		// 实体名消失：王城/艾琳 在原文出现，改写后不见
		const lost = stylizeFactCheck("艾琳走进王城。", "她走进城内。", story);
		assert.equal(lost.ok, false);
		assert.ok(lost.drift.some((d) => d.includes("「艾琳」在改写后消失")));
		assert.ok(lost.drift.some((d) => d.includes("「王城」在改写后消失")));
		// 实体名新增：市集 原文未出现，改写后出现
		const added = stylizeFactCheck("他在城里闲逛。", "他在市集闲逛。", story);
		assert.equal(added.ok, false);
		assert.ok(added.drift.some((d) => d.includes("改写后新增原文未出现的实体名「市集」")));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("stylizeFactCheck：篇幅膨胀（>1.8x）→ drift", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		const original = "他推开了门。";
		const rewritten = "他伸手握住冰凉的门把手，缓缓用力，把那扇沉重的木门一寸一寸地推开，门轴发出吱呀的声响，在安静的走廊里回荡了很久很久很久很久很久。";
		const result = stylizeFactCheck(original, rewritten, story);
		assert.equal(result.ok, false);
		assert.ok(result.drift.some((d) => d.includes("篇幅膨胀")));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// runStylize
// ---------------------------------------------------------------------------

test("runStylize：成功 applied=true（stub 返回合法润色文本）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		const original = "艾琳走进王城，递给贝罗 3 枚铜币。";
		const executor = async (opts: SubagentRunOptions) => {
			// systemPrompt 的 {{style_hint}} 已注入默认文风
			assert.ok(opts.systemPrompt.includes("style_hint") === false);
			return stubResult({ text: "王城之内，艾琳走到贝罗面前，递上 3 枚铜币。" });
		};
		const result = await runStylize(
			{ turnSeq: 1, narrativeText: original },
			{ storyDb: story, cwd: dir, executor },
		);
		assert.equal(result.applied, true);
		assert.ok(result.text.includes("王城之内"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runStylize：事实漂移 → 反馈重试自纠 → 成功（applied=true）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		const original = "他付了 3 枚铜币。";
		const prompts: string[] = [];
		let call = 0;
		const executor = async (opts: SubagentRunOptions) => {
			prompts.push(opts.userPrompt);
			call++;
			if (call === 1) return stubResult({ text: "他付了 4 枚铜币。" }); // 数字漂移
			return stubResult({ text: "他付了 3 枚铜币。" });
		};
		const result = await runStylize(
			{ turnSeq: 1, narrativeText: original },
			{ storyDb: story, cwd: dir, executor },
		);
		assert.equal(result.applied, true);
		assert.equal(result.text, "他付了 3 枚铜币。");
		assert.equal(call, 2);
		assert.ok(prompts[1]!.includes("上次提交失败反馈"));
		assert.ok(prompts[1]!.includes("零漂移抽查"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runStylize：恒漂移重试耗尽 → 回退原文 applied=false + drift 记录 + eventLog", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStylizeStory(story);
		const original = "他付了 3 枚铜币。";
		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async () => stubResult({ text: "他付了 4 枚铜币。" }); // 恒漂移
		const result = await runStylize(
			{ turnSeq: 1, narrativeText: original },
			{ storyDb: story, cwd: dir, executor, eventLog: log },
		);
		assert.equal(result.applied, false);
		assert.equal(result.text, original, "回退原文");
		assert.ok(result.drift?.some((d) => d.includes("数字集合不一致")));
		const stylizeRecords = records.filter((r) => r.role === "stylize");
		assert.equal(stylizeRecords.length, 2, "maxAttempts 默认 2");
		assert.ok(stylizeRecords.every((r) => r.ok === false));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
