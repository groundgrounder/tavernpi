// npc subagent 纯模块层单测（§6.2；stub executor 全程无 LLM）：确定性场景规划、
// 在场预演并行/重试/降级/防串台、离线批量校验与权威边界结构强制、渲染器。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import type { SubagentResult, SubagentRunOptions, SubagentUsage } from "../src/subagent/runtime.ts";
import { createPipelineEventLog, type PipelineEvent } from "../src/pipeline/events.ts";
import {
	computeScenePlan,
	OFFSCREEN_LAST_TURN_PREFIX,
	offscreenLastTurnKey,
	offscreenZodSchema,
	renderOffscreenDeltasForData,
	renderRehearsals,
	rehearsalZodSchema,
	runOffscreenBatch,
	runOnstageRehearsals,
	type NpcRehearsal,
	type OffscreenDelta,
} from "../src/pipeline/npc-stage.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function openTempStory(dir: string): StoryDb {
	return openStoryDb(join(dir, "story.db"));
}

/** seed：王城（玩家在此）> 庭院、市集；艾琳在场（王城）、罗德离线（市集）、亡者 dead。 */
function seedNpcStageStory(story: StoryDb): { wangChengId: number; marketId: number; onstageId: number; offId: number; deadId: number } {
	const wangCheng = story.writer.insertLocation({ name: "王城" });
	story.writer.insertLocation({ name: "庭院", parentId: wangCheng.id });
	const market = story.writer.insertLocation({ name: "市集" });
	story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: wangCheng.id });
	const onstage = story.writer.insertNpc({ name: "艾琳" });
	story.writer.moveSubject({ turnSeq: 1, subject: `npc:${onstage.id}`, toLocationId: wangCheng.id });
	const off = story.writer.insertNpc({ name: "罗德" });
	story.writer.moveSubject({ turnSeq: 1, subject: `npc:${off.id}`, toLocationId: market.id });
	const dead = story.writer.insertNpc({ name: "亡者", status: "dead" });
	return { wangChengId: wangCheng.id, marketId: market.id, onstageId: onstage.id, offId: off.id, deadId: dead.id };
}

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

/** 从预演 userPrompt 解析请求的 NPC id（角色档案行 `NPC #<id> <name>`）。 */
function requestedNpcId(prompt: string): number {
	const m = /NPC #(\d+)/.exec(prompt);
	return m ? Number(m[1]) : -1;
}

function validRehearsal(npcId: number): unknown {
	return {
		npc_id: npcId,
		intent: "观察来客",
		mood: "平静",
		action_points: ["保持原位"],
		dialogue_cues: ["打声招呼"],
		unaware_of: ["玩家内心"],
		ooc_check: { passed: true },
	};
}

// ---------------------------------------------------------------------------
// 确定性场景规划
// ---------------------------------------------------------------------------

test("computeScenePlan：在场匹配 / dead 排除 / 触发边界（K-1 不触发、K 触发）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);

		// turn 4（默认 afterTurns=5，lastTurn=0）：4-0 < 5 不触发
		let plan = computeScenePlan(story, 4);
		assert.deepEqual(plan.onstage.map((n) => n.id), [ids.onstageId]);
		assert.deepEqual(plan.offscreenTriggered, []);
		// turn 5：5-0 >= 5 触发（缺省键按 0 计）
		plan = computeScenePlan(story, 5);
		assert.deepEqual(plan.offscreenTriggered.map((n) => n.id), [ids.offId]);
		// dead 永不在场也不推演
		const allIds = [...plan.onstage, ...plan.offscreenTriggered].map((n) => n.id);
		assert.ok(!allIds.includes(ids.deadId), "dead NPC 不得出现在任何场景");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("computeScenePlan：玩家未定位 → onstage 空、非 dead 全进候选", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const npc1 = story.writer.insertNpc({ name: "甲" });
		const npc2 = story.writer.insertNpc({ name: "乙" });
		story.writer.insertNpc({ name: "亡者", status: "dead" });
		const plan = computeScenePlan(story, 5);
		assert.deepEqual(plan.onstage, [], "玩家未定位 → 无在场");
		assert.deepEqual(
			[...plan.offscreenTriggered.map((n) => n.id)].sort(),
			[npc1.id, npc2.id].sort(),
			"非 dead 全进候选并按轮数触发",
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("computeScenePlan：offscreenAfterTurns 自定义 / sys 簿记键生效", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);

		// 自定义阈值 2：turn 2 → 2-0 >= 2 触发
		assert.deepEqual(computeScenePlan(story, 2, { offscreenAfterTurns: 2 }).offscreenTriggered.map((n) => n.id), [ids.offId]);

		// 簿记键 last_turn=3、阈值 3：turn 5（2<3）不触发、turn 6（3>=3）触发
		story.writer.upsertWorldState({ key: offscreenLastTurnKey(ids.offId), value: "3", turnSeq: 1 });
		assert.deepEqual(computeScenePlan(story, 5, { offscreenAfterTurns: 3 }).offscreenTriggered, []);
		assert.deepEqual(computeScenePlan(story, 6, { offscreenAfterTurns: 3 }).offscreenTriggered.map((n) => n.id), [ids.offId]);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("offscreenLastTurnKey：键格式与 sys_ 前缀（内核保留键命名空间）", () => {
	assert.equal(OFFSCREEN_LAST_TURN_PREFIX, "sys_npc_offscreen_last_turn:");
	assert.equal(offscreenLastTurnKey(7), "sys_npc_offscreen_last_turn:7");
});

// ---------------------------------------------------------------------------
// 在场预演（runOnstageRehearsals）
// ---------------------------------------------------------------------------

test("runOnstageRehearsals：2 NPC 并行全成功（两个 rehearsal + eventLog 两条 ok）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const second = story.writer.insertNpc({ name: "多恩" });
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${second.id}`, toLocationId: ids.wangChengId });
		const plan = computeScenePlan(story, 5);
		assert.equal(plan.onstage.length, 2);

		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async (opts: SubagentRunOptions) => stubResult(validRehearsal(requestedNpcId(opts.userPrompt)));

		const result = await runOnstageRehearsals(plan.onstage, 5, "玩家走进来", { storyDb: story, cwd: dir, executor, eventLog: log });
		assert.equal(result.length, 2, "两个在场 NPC 都返回预演");
		const resultIds = result.map((r) => r.npc_id).sort((a, b) => a - b);
		assert.deepEqual(resultIds, [ids.onstageId, second.id].sort((a, b) => a - b));

		const onstageRecords = records.filter((r) => r.role === "npc_onstage");
		assert.equal(onstageRecords.length, 2);
		assert.ok(onstageRecords.every((r) => r.ok === true));
		assert.ok(onstageRecords.every((r) => typeof r.attempt === "number"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOnstageRehearsals：首次垃圾 → 反馈进下次 attempt → 成功", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const plan = computeScenePlan(story, 5); // onstage = [艾琳]

		const callsByNpc = new Map<number, number>();
		const prompts: string[] = [];
		const badFirst = new Set([ids.onstageId]);
		const executor = async (opts: SubagentRunOptions) => {
			prompts.push(opts.userPrompt);
			const id = requestedNpcId(opts.userPrompt);
			const n = callsByNpc.get(id) ?? 0;
			callsByNpc.set(id, n + 1);
			if (n === 0 && badFirst.has(id)) return stubResult({ npc_id: id, intent: 123 }); // zod 形状垃圾
			return stubResult(validRehearsal(id));
		};

		const result = await runOnstageRehearsals(plan.onstage, 5, "玩家走进来", { storyDb: story, cwd: dir, executor });
		assert.equal(result.length, 1);
		assert.equal(result[0]?.npc_id, ids.onstageId);
		assert.equal(callsByNpc.get(ids.onstageId), 2, "首败后重试一次");
		assert.ok(prompts.some((p) => p.includes("上次提交失败反馈")), "重试 attempt 的 userPrompt 含反馈");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOnstageRehearsals：恒垃圾 NPC 被丢弃，另一 NPC 正常返回（降级不阻塞）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const second = story.writer.insertNpc({ name: "多恩" });
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${second.id}`, toLocationId: ids.wangChengId });
		const plan = computeScenePlan(story, 5);

		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const alwaysBad = new Set([ids.onstageId]);
		const executor = async (opts: SubagentRunOptions) => {
			const id = requestedNpcId(opts.userPrompt);
			if (alwaysBad.has(id)) return stubResult({ npc_id: id, intent: 123 });
			return stubResult(validRehearsal(id));
		};

		const result = await runOnstageRehearsals(plan.onstage, 5, "玩家走进来", {
			storyDb: story,
			cwd: dir,
			executor,
			eventLog: log,
		});
		assert.equal(result.length, 1, "垃圾 NPC 被丢弃");
		assert.equal(result[0]?.npc_id, second.id, "正常 NPC 仍返回");
		const onstageRecords = records.filter((r) => r.role === "npc_onstage");
		assert.ok(onstageRecords.some((r) => r.ok === false), "eventLog 记 ok:false");
		// 恒垃圾 NPC 默认 maxAttempts=2 → 2 条失败记录
		assert.equal(onstageRecords.filter((r) => r.ok === false).length, 2);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOnstageRehearsals：npc_id 串台（返回别人的 id）→ 重试 → 失败丢弃", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const wangCheng = story.writer.insertLocation({ name: "王城" });
		story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: wangCheng.id });
		const npc = story.writer.insertNpc({ name: "艾琳" });
		story.writer.moveSubject({ turnSeq: 1, subject: `npc:${npc.id}`, toLocationId: wangCheng.id });
		const plan = computeScenePlan(story, 1);

		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async () => stubResult(validRehearsal(999)); // 恒串台

		const result = await runOnstageRehearsals(plan.onstage, 1, "u", { storyDb: story, cwd: dir, executor, eventLog: log });
		assert.deepEqual(result, []);
		assert.ok(
			records.some((r) => r.role === "npc_onstage" && r.ok === false && (r.error ?? "").includes("串台")),
			"eventLog 错误含防串台说明",
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOnstageRehearsals：directives 非空 → 预演 userPrompt 含「作者指令」节（§6.3 下达）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const plan = computeScenePlan(story, 5); // onstage = [艾琳]

		const prompts: string[] = [];
		const executor = async (opts: SubagentRunOptions) => {
			prompts.push(opts.userPrompt);
			return stubResult(validRehearsal(requestedNpcId(opts.userPrompt)));
		};

		const directives = ["梅子酒今晚卖完就收摊", "不得与玩家起正面冲突"];
		const result = await runOnstageRehearsals(plan.onstage, 5, "玩家走进来", { storyDb: story, cwd: dir, executor, directives });
		assert.equal(result.length, 1);
		assert.equal(prompts.length, 1);
		assert.match(prompts[0]!, /## 作者指令（剧本要求）/);
		for (const d of directives) {
			assert.ok(prompts[0]!.includes(d), `指令「${d}」逐条列出`);
		}
		// 指令节在玩家输入之后、指令节之前
		const userIdx = prompts[0]!.indexOf("## 本轮玩家输入");
		const authorIdx = prompts[0]!.indexOf("## 作者指令");
		assert.ok(userIdx !== -1 && authorIdx > userIdx);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOnstageRehearsals：directives 缺省 → 预演 userPrompt 不含作者指令节（M3 形态不变）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const plan = computeScenePlan(story, 5);

		let prompt = "";
		const executor = async (opts: SubagentRunOptions) => {
			prompt = opts.userPrompt;
			return stubResult(validRehearsal(requestedNpcId(opts.userPrompt)));
		};

		const result = await runOnstageRehearsals(plan.onstage, 5, "玩家走进来", { storyDb: story, cwd: dir, executor });
		assert.equal(result.length, 1);
		assert.doesNotMatch(prompt, /作者指令/);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 离线批量推演（runOffscreenBatch）
// ---------------------------------------------------------------------------

test("runOffscreenBatch：成功返回 deltas（location_name 已登记）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const rod = story.reader.listNpcs().find((n) => n.id === ids.offId)!;

		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async () =>
			stubResult({ deltas: [{ npc_id: ids.offId, activity: "巡街", location_name: "市集" }] });

		const deltas = await runOffscreenBatch([rod], 5, { storyDb: story, cwd: dir, executor, eventLog: log });
		assert.equal(deltas.length, 1);
		assert.equal(deltas[0]?.npc_id, ids.offId);
		assert.equal(deltas[0]?.location_name, "市集");
		assert.ok(records.some((r) => r.role === "npc_offscreen" && r.ok === true));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOffscreenBatch：npc_id 不在名单 → 反馈重试 → 修正后成功", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const rod = story.reader.listNpcs().find((n) => n.id === ids.offId)!;

		const prompts: string[] = [];
		let call = 0;
		const executor = async (opts: SubagentRunOptions) => {
			prompts.push(opts.userPrompt);
			call++;
			if (call === 1) return stubResult({ deltas: [{ npc_id: 999, activity: "错" }] });
			return stubResult({ deltas: [{ npc_id: ids.offId, activity: "巡街", location_name: "市集" }] });
		};

		const deltas = await runOffscreenBatch([rod], 5, { storyDb: story, cwd: dir, executor });
		assert.equal(deltas.length, 1);
		assert.equal(deltas[0]?.npc_id, ids.offId);
		assert.ok(prompts[1]!.includes("上次提交失败反馈"));
		assert.ok(prompts[1]!.includes("不在本次离线推演名单"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOffscreenBatch：location_name 未登记 → 重试耗尽 → 返回 []", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const rod = story.reader.listNpcs().find((n) => n.id === ids.offId)!;

		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async () =>
			stubResult({ deltas: [{ npc_id: ids.offId, activity: "x", location_name: "不存在的地方" }] });

		const deltas = await runOffscreenBatch([rod], 5, { storyDb: story, cwd: dir, executor, eventLog: log });
		assert.deepEqual(deltas, []);
		const offRecords = records.filter((r) => r.role === "npc_offscreen");
		assert.ok(offRecords.every((r) => r.ok === false), "失败记录全部 ok:false");
		assert.ok(offRecords.some((r) => (r.error ?? "").includes("未登记")));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 权威边界结构强制（schema 层）
// ---------------------------------------------------------------------------

test("offscreenZodSchema：status 排除 dead（场外致死 = 背着玩家剧变）", () => {
	const dead = offscreenZodSchema.safeParse({ deltas: [{ npc_id: 1, activity: "x", status: "dead" }] });
	assert.equal(dead.success, false, "status:'dead' 必须被 schema 拒绝");
	const absent = offscreenZodSchema.safeParse({ deltas: [{ npc_id: 1, activity: "x", status: "absent" }] });
	assert.equal(absent.success, true);
});

test("token 预算机械强制：超上限数组/超长字段被拒", () => {
	const overActions = rehearsalZodSchema.safeParse({
		npc_id: 1,
		intent: "i",
		mood: "m",
		action_points: Array.from({ length: 6 }, (_, i) => `点${i}`), // 6 > 5
		dialogue_cues: [],
		unaware_of: [],
		ooc_check: { passed: true },
	});
	assert.equal(overActions.success, false, "action_points 6 条应被拒");
	const overDeltas = offscreenZodSchema.safeParse({
		deltas: Array.from({ length: 13 }, () => ({ npc_id: 1, activity: "x" })), // 13 > 12
	});
	assert.equal(overDeltas.success, false, "deltas 13 条应被拒");
	const overLongIntent = rehearsalZodSchema.safeParse({
		npc_id: 1,
		intent: "i".repeat(121), // > 120
		mood: "m",
		action_points: [],
		dialogue_cues: [],
		unaware_of: [],
		ooc_check: { passed: true },
	});
	assert.equal(overLongIntent.success, false, "intent 超长应被拒");
	const overMemories = offscreenZodSchema.safeParse({
		deltas: [
			{
				npc_id: 1,
				activity: "x",
				memories: Array.from({ length: 4 }, (_, i) => ({ kind: "k", content: `c${i}` })), // 4 > 3
			},
		],
	});
	assert.equal(overMemories.success, false, "memories 4 条应被拒");
});

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------

test("renderRehearsals：各小节与 NPC 名；OOC 未过时用修正版", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);

		const rehearsals: NpcRehearsal[] = [
			{
				npc_id: ids.onstageId,
				intent: "守摊",
				mood: "平静",
				action_points: ["看着来往行人"],
				dialogue_cues: ["问一句"],
				unaware_of: ["玩家是密探"],
				ooc_check: { passed: true },
			},
		];
		const text = renderRehearsals(rehearsals, story);
		assert.ok(text.includes("导演批注"), "开头说明行");
		assert.ok(text.includes(`艾琳#${ids.onstageId}`), "NPC 小节头");
		assert.ok(text.includes("守摊"));
		assert.ok(text.includes("玩家是密探"));

		// OOC 未过 + 有修正版 → 用修正版并标注
		const fixed = renderRehearsals(
			[
				{
					npc_id: ids.onstageId,
					intent: "x",
					mood: "y",
					action_points: ["原案行动"],
					dialogue_cues: [],
					unaware_of: [],
					ooc_check: { passed: false, risks: "原案违背性格", revised_action_points: ["修正案行动"] },
				},
			],
			story,
		);
		assert.ok(fixed.includes("修正案行动"));
		assert.ok(!fixed.includes("原案行动"), "未过 OOC 时不得用原案行动");
		assert.ok(fixed.includes("已按 OOC 自检修正"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("renderOffscreenDeltasForData：含 npc id/活动/转写指示", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedNpcStageStory(story);
		const deltas: OffscreenDelta[] = [
			{ npc_id: ids.offId, activity: "巡街", location_name: "市集", status: "absent" },
		];
		const text = renderOffscreenDeltasForData(deltas, story);
		assert.ok(text.includes(`#${ids.offId}`));
		assert.ok(text.includes("罗德"));
		assert.ok(text.includes("巡街"));
		assert.ok(text.includes("移动目标: 市集"));
		assert.ok(text.includes("location_moves"), "转写指示：位置走 location_moves");
		assert.ok(text.includes("npc_updates"), "转写指示：记忆/状态/关系走 npc_updates");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
