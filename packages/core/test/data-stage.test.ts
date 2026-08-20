// data subagent 编排单测（executor 桩，全程无真实 LLM）：一次成功、首败自纠、
// 恒败耗尽、executor 抛错重试、pendingTurns 注入、eventLog 每次 attempt 记录、
// offscreenDeltas 注入（§6.2 npc 层产物转写输入；空/缺省不加节）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import type { SubagentResult, SubagentUsage } from "../src/subagent/runtime.ts";
import { createPipelineEventLog, type PipelineEvent } from "../src/pipeline/events.ts";
import { runDataStage, type DataStageOptions } from "../src/pipeline/data-stage.ts";

const USAGE: SubagentUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0 };

function openTempStory(dir: string): StoryDb {
	return openStoryDb(join(dir, "story.db"));
}

/** 合法变更集（时钟默认 0000-01-01，推进到 0000-01-02 合法）。 */
const validChangeset = {
	events: [{ summary: "城门洞开", location_name: "王城" }],
	new_locations: [{ name: "王城" }],
	time_advance: { to_time: "0000-01-02", span_note: "一日" },
};

function result(output: unknown): SubagentResult<unknown> {
	return { output, usage: USAGE, durationMs: 1 };
}

test("runDataStage：一次成功（attempts=1，变更计数正确）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const outcome = await runDataStage({
			storyDb: story,
			input: { turnSeq: 1, userInput: "推门", narrativeText: "他推开了城门。", pendingTurns: [] },
			cwd: dir,
			executor: async () => result(validChangeset),
		});
		assert.equal(outcome.ok, true);
		if (outcome.ok) {
			assert.equal(outcome.attempts, 1);
			assert.equal(outcome.applied.events, 1);
			assert.equal(outcome.applied.newLocations, 1);
			assert.equal(outcome.applied.timeAdvanced, true);
			assert.deepEqual(outcome.usage, USAGE);
		}
		// 落库可见
		assert.equal(story.reader.listEvents().length, 1);
		assert.equal(story.reader.getClock()?.current_time, "0000-01-02");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：首败自纠——第一次输出形状非法，第二次 userPrompt 含校验反馈后成功", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const prompts: string[] = [];
		let call = 0;
		const outcome = await runDataStage({
			storyDb: story,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [] },
			cwd: dir,
			executor: async (opts) => {
				prompts.push(opts.userPrompt);
				call++;
				if (call === 1) return result({ events: [{ summary: 123 }] }); // zod 形状非法
				return result(validChangeset);
			},
		});
		assert.equal(outcome.ok, true);
		if (outcome.ok) {
			assert.equal(outcome.attempts, 2);
		}
		assert.equal(prompts.length, 2);
		assert.match(prompts[1]!, /上次提交失败反馈/);
		assert.match(prompts[1]!, /schema 校验/);
		// 第二次提交真正落库
		assert.equal(story.reader.listEvents().length, 1);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：恒败（语义校验失败）→ ok:false、attempts=maxAttempts、error 含原因", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const maxAttempts = 3;
		const outcome = await runDataStage({
			storyDb: story,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [] },
			cwd: dir,
			maxAttempts,
			executor: async () => result({ events: [{ summary: "x", location_name: "未知地点" }] }),
		});
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.attempts, maxAttempts);
			assert.match(outcome.error, /变更集校验失败/);
			assert.match(outcome.error, /未知地点/);
		}
		assert.equal(story.reader.listEvents().length, 0, "全程失败 → 零写入");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：executor 抛错 → 进重试 → 耗尽返回 ok:false", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const outcome = await runDataStage({
			storyDb: story,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [] },
			cwd: dir,
			maxAttempts: 2,
			executor: async () => {
				throw new Error("LLM 崩了");
			},
		});
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.equal(outcome.attempts, 2);
			assert.match(outcome.error, /执行失败/);
			assert.match(outcome.error, /LLM 崩了/);
		}
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：pendingTurns 出现在 userPrompt（待补齐轮一并抽取）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		let prompt = "";
		const outcome = await runDataStage({
			storyDb: story,
			input: {
				turnSeq: 3,
				userInput: "现在",
				narrativeText: "当前轮叙事",
				pendingTurns: [
					{ turnSeq: 1, userInput: "旧输入", narrativeText: "旧轮叙事一" },
					{ turnSeq: 2, userInput: "更旧输入", narrativeText: "旧轮叙事二" },
				],
			},
			cwd: dir,
			executor: async (opts) => {
				prompt = opts.userPrompt;
				return result(validChangeset);
			},
		});
		assert.equal(outcome.ok, true);
		assert.match(prompt, /待补齐轮次/);
		assert.match(prompt, /turn 1/);
		assert.match(prompt, /旧轮叙事一/);
		assert.match(prompt, /turn 2/);
		assert.match(prompt, /旧轮叙事二/);
		assert.match(prompt, /当前轮叙事/);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：offscreenDeltas 非空 → userPrompt 含离线 NPC 推演产物区块（npc id 与转写指示可见）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		let prompt = "";
		const outcome = await runDataStage({
			storyDb: story,
			input: {
				turnSeq: 2,
				userInput: "u",
				narrativeText: "n",
				pendingTurns: [],
				offscreenDeltas: [{ npc_id: 7, activity: "在集市闲逛", location_name: "集市" }],
			},
			cwd: dir,
			executor: async (opts) => {
				prompt = opts.userPrompt;
				return result(validChangeset);
			},
		});
		assert.equal(outcome.ok, true);
		// 区块标题 + P1 renderOffscreenDeltasForData 渲染内容（npc id / 活动 / 转写指示）
		assert.match(prompt, /## 离线 NPC 推演产物/);
		assert.match(prompt, /#7/);
		assert.match(prompt, /在集市闲逛/);
		assert.match(prompt, /转写进变更集落库/);
		// 与任务节共存（抽取对象仍在）
		assert.match(prompt, /## 指令/);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：offscreenDeltas 缺省/空 → userPrompt 不含离线区块（M2 输入形态不变）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		let prompt = "";
		const outcome = await runDataStage({
			storyDb: story,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [] },
			cwd: dir,
			executor: async (opts) => {
				prompt = opts.userPrompt;
				return result(validChangeset);
			},
		});
		assert.equal(outcome.ok, true);
		assert.doesNotMatch(prompt, /离线 NPC 推演产物/);
		story.close();

		// 空数组同样不加节
		const story2 = openTempStory(dir);
		let prompt2 = "";
		const outcome2 = await runDataStage({
			storyDb: story2,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [], offscreenDeltas: [] },
			cwd: dir,
			executor: async (opts) => {
				prompt2 = opts.userPrompt;
				return result(validChangeset);
			},
		});
		assert.equal(outcome2.ok, true);
		assert.doesNotMatch(prompt2, /离线 NPC 推演产物/);
		story2.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runDataStage：eventLog 每次 attempt 有记录（成功 1 条 / 多轮失败逐条）", async () => {
	const dir = makeTempDir();
	try {
		// 成功路径：1 条
		const story1 = openTempStory(dir);
		const log1 = createPipelineEventLog();
		const records1: PipelineEvent[] = [];
		log1.on((e) => records1.push(e));
		const ok = await runDataStage({
			storyDb: story1,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [] },
			cwd: dir,
			eventLog: log1,
			executor: async () => result(validChangeset),
		});
		assert.equal(ok.ok, true);
		assert.equal(records1.length, 1);
		assert.equal(records1[0]?.role, "data");
		assert.equal(records1[0]?.ok, true);
		assert.equal(records1[0]?.attempt, 1);
		assert.ok(records1[0]?.durationMs !== undefined);
		story1.close();

		// 失败路径：3 条（每次 attempt 一条，attempt 编号 1..3）
		const story2 = openTempStory(dir);
		const log2 = createPipelineEventLog();
		const records2: PipelineEvent[] = [];
		log2.on((e) => records2.push(e));
		const fail = await runDataStage({
			storyDb: story2,
			input: { turnSeq: 1, userInput: "u", narrativeText: "n", pendingTurns: [] },
			cwd: dir,
			eventLog: log2,
			maxAttempts: 3,
			executor: async () => result({ events: [{ summary: "x", location_name: "未知地点" }] }),
		});
		assert.equal(fail.ok, false);
		assert.equal(records2.length, 3);
		assert.deepEqual(
			records2.map((r) => r.attempt),
			[1, 2, 3],
		);
		assert.ok(records2.every((r) => r.ok === false && r.error !== undefined));
		story2.close();
	} finally {
		cleanupTempDir(dir);
	}
});
