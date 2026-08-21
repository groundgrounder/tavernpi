// story subagent 纯模块层单测（§6.3；stub executor 无 LLM）：场景卡校验、场景分析成功/重试/降级、
// 规则层六条断言、审查/统筹 runner、渲染器。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import type { SubagentResult, SubagentRunOptions, SubagentUsage } from "../src/subagent/runtime.ts";
import { createPipelineEventLog, type PipelineEvent } from "../src/pipeline/events.ts";
import {
	buildFallbackSceneCard,
	renderOverseeNote,
	renderRevisionRequest,
	renderSceneCardForNarrator,
	runOversee,
	runReview,
	runRuleChecks,
	runSceneAnalysis,
	sceneCardZodSchema,
	validateSceneCard,
	type OverseeNote,
	type SceneCard,
} from "../src/pipeline/story-stage.ts";

const ZERO: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

function openTempStory(dir: string): StoryDb {
	return openStoryDb(join(dir, "story.db"));
}

/** seed：王城（玩家在此，艾琳在场）、市集（罗德离线）、亡者（dead）。clock 默认 0000-01-01。 */
function seedStoryStageStory(story: StoryDb): { wangChengId: number; marketId: number; onstageId: number; offId: number; deadId: number } {
	const wangCheng = story.writer.insertLocation({ name: "王城" });
	const market = story.writer.insertLocation({ name: "市集" });
	story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: wangCheng.id });
	const onstage = story.writer.insertNpc({ name: "艾琳" });
	story.writer.moveSubject({ turnSeq: 1, subject: `npc:${onstage.id}`, toLocationId: wangCheng.id });
	const off = story.writer.insertNpc({ name: "罗德" });
	story.writer.moveSubject({ turnSeq: 1, subject: `npc:${off.id}`, toLocationId: market.id });
	const dead = story.writer.insertNpc({ name: "亡者", status: "dead" });
	return { wangChengId: wangCheng.id, marketId: market.id, onstageId: onstage.id, offId: off.id, deadId: dead.id };
}

function validCard(ids: { onstageId: number; offId: number }): SceneCard {
	return {
		onstage_npc_ids: [ids.onstageId],
		offscreen_npc_ids: [{ npc_id: ids.offId, reason: "在市集推演" }],
		scene_location_name: "王城",
		current_story_time: "0000-01-01",
		time_span_estimate: "几句话的工夫",
		to_time_suggestion: "0000-01-01",
		scene_goal: "与艾琳交谈",
		tone: "平静",
		major_event: false,
	};
}

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO, durationMs: 1 };
}

// ---------------------------------------------------------------------------
// 场景卡 zod / 语义校验
// ---------------------------------------------------------------------------

test("sceneCardZodSchema：形状校验（缺字段/类型错被拒，合法通过）", () => {
	const ok = sceneCardZodSchema.safeParse({
		onstage_npc_ids: [1],
		offscreen_npc_ids: [],
		scene_location_name: "王城",
		current_story_time: "0000-01-01",
		time_span_estimate: "x",
		to_time_suggestion: "0000-01-01",
		scene_goal: "g",
		tone: "t",
		major_event: false,
	});
	assert.equal(ok.success, true);
	const bad = sceneCardZodSchema.safeParse({ onstage_npc_ids: [1] }); // 缺必填
	assert.equal(bad.success, false);
	const badType = sceneCardZodSchema.safeParse({
		onstage_npc_ids: ["x"],
		offscreen_npc_ids: [],
		scene_location_name: "王城",
		current_story_time: "0000-01-01",
		time_span_estimate: "x",
		to_time_suggestion: "0000-01-01",
		scene_goal: "g",
		tone: "t",
		major_event: "yes",
	});
	assert.equal(badType.success, false);
});

test("validateSceneCard：dead 在场 / 未登记地点 / 时间幻觉 / 未知 npc", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const card: SceneCard = {
			onstage_npc_ids: [ids.deadId, 999], // dead + 未知
			offscreen_npc_ids: [{ npc_id: ids.offId, reason: "r" }],
			scene_location_name: "不存在的地方",
			current_story_time: "9999-99-99", // 时间幻觉
			time_span_estimate: "",
			to_time_suggestion: "",
			scene_goal: "",
			tone: "",
			major_event: false,
		};
		const problems = validateSceneCard(story, card);
		assert.ok(problems.some((p) => p.includes("dead")), "dead 在场被拒");
		assert.ok(problems.some((p) => p.includes("引用不存在的 NPC #999")), "未知 npc 被拒");
		assert.ok(problems.some((p) => p.includes("scene_location_name 未登记")), "未登记地点被拒");
		assert.ok(problems.some((p) => p.includes("current_story_time 与 clock 不一致")), "时间幻觉被拒");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// runSceneAnalysis
// ---------------------------------------------------------------------------

test("runSceneAnalysis：成功（stub 返回合法卡，fallback=false）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const executor = async () => stubResult(validCard(ids));
		const result = await runSceneAnalysis(
			{ turnSeq: 1, userInput: "走进王城", recentNarratives: [] },
			{ storyDb: story, cwd: dir, executor },
		);
		assert.equal(result.fallback, false);
		assert.deepEqual(result.card.onstage_npc_ids, [ids.onstageId]);
		assert.equal(result.card.current_story_time, "0000-01-01");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runSceneAnalysis：首次垃圾 → 反馈进下次 attempt → 成功", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const prompts: string[] = [];
		let call = 0;
		const executor = async (opts: SubagentRunOptions) => {
			prompts.push(opts.userPrompt);
			call++;
			if (call === 1) return stubResult({ onstage_npc_ids: [ids.onstageId] }); // 缺必填
			return stubResult(validCard(ids));
		};
		const result = await runSceneAnalysis(
			{ turnSeq: 1, userInput: "走进王城", recentNarratives: [] },
			{ storyDb: story, cwd: dir, executor },
		);
		assert.equal(result.fallback, false);
		assert.ok(prompts[1]!.includes("上次提交失败反馈"));
		assert.ok(prompts[1]!.includes("schema 校验"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runSceneAnalysis：重试耗尽 → fallback=true 确定性兜底卡 + eventLog ok:false", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async () => stubResult({ onstage_npc_ids: [999] }); // 恒语义垃圾（未知 npc）
		const result = await runSceneAnalysis(
			{ turnSeq: 1, userInput: "走进王城", recentNarratives: [] },
			{ storyDb: story, cwd: dir, executor, eventLog: log },
		);
		assert.equal(result.fallback, true);
		// 兜底卡 = 确定性判定：在场=玩家位置 NPC、离线空、时间=clock
		assert.deepEqual(result.card.onstage_npc_ids, [ids.onstageId]);
		assert.deepEqual(result.card.offscreen_npc_ids, []);
		assert.equal(result.card.scene_location_name, "王城");
		assert.equal(result.card.current_story_time, "0000-01-01");
		assert.equal(result.card.major_event, false);
		const sceneRecords = records.filter((r) => r.role === "story_scene");
		assert.equal(sceneRecords.length, 2, "maxAttempts 默认 2");
		assert.ok(sceneRecords.every((r) => r.ok === false));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("buildFallbackSceneCard：玩家未定位 → 在场空、地点空串（降级不阻塞）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		story.writer.insertNpc({ name: "路人" });
		const card = buildFallbackSceneCard(story);
		assert.deepEqual(card.onstage_npc_ids, []);
		assert.equal(card.scene_location_name, "");
		assert.equal(card.current_story_time, "0000-01-01");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 规则层六条断言（runRuleChecks）
// ---------------------------------------------------------------------------

test("runRuleChecks：六条断言逐一触发", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		story.writer.advanceClock({ turnSeq: 1, toTime: "0000-01-05" }); // clock 推进到 0000-01-05

		const card: SceneCard = {
			onstage_npc_ids: [ids.onstageId, ids.deadId], // 规则 1：dead 在场
			offscreen_npc_ids: [
				{ npc_id: ids.onstageId, reason: "r" }, // 规则 3：在场 ∩ 离线
				{ npc_id: ids.offId, reason: "r" },
			],
			scene_location_name: "王城",
			current_story_time: "0000-01-01", // 规则 4：时间幻觉（clock=0000-01-05）
			time_span_estimate: "",
			to_time_suggestion: "",
			scene_goal: "",
			tone: "",
			major_event: false,
		};
		// 规则 2：艾琳 current_location=王城=玩家位置 → 不触发；把艾琳挪到市集 → 触发
		story.writer.moveSubject({ turnSeq: 2, subject: `npc:${ids.onstageId}`, toLocationId: ids.marketId });

		const narrative = "他想起亡者生前的叮嘱，又记起 0000-01-02 那天的旧事。"; // 规则 5/6
		const result = runRuleChecks({ sceneCard: card, storyDb: story, narrativeText: narrative, turnSeq: 2 });

		assert.ok(result.hardConflicts.some((c) => c.includes("dead")), "规则1：dead 在场");
		assert.ok(result.hardConflicts.some((c) => c.includes("≠ 玩家位置")), "规则2：在场 NPC 位置不符");
		assert.ok(result.hardConflicts.some((c) => c.includes("同时出现在在场名单与离线名单")), "规则3：在场∩离线");
		assert.ok(result.hardConflicts.some((c) => c.includes("时间幻觉")), "规则4：current_story_time≠clock");
		assert.ok(result.suspicions.some((s) => s.includes("死者名字")), "规则5：叙事含死者名字");
		assert.ok(result.suspicions.some((s) => s.includes("早于当前故事时间")), "规则6：叙事含早于 clock 的日期");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runRuleChecks：合法场景卡 + 无问题叙事 → 空结果", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const result = runRuleChecks({
			sceneCard: validCard(ids),
			storyDb: story,
			narrativeText: "艾琳递来一杯热茶。",
			turnSeq: 1,
		});
		assert.deepEqual(result.hardConflicts, []);
		assert.deepEqual(result.suspicions, []);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// runReview / runOversee
// ---------------------------------------------------------------------------

test("runReview：报疑清单进入 userPrompt；成功返回 findings", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const suspicions = ["叙事文本出现死者名字「亡者」"];
		const captured: string[] = [];
		const executor = async (opts: SubagentRunOptions) => {
			captured.push(opts.userPrompt);
			return stubResult({
				findings: [{ kind: "ooc", description: "艾琳言行与档案矛盾", severity: "hard" }],
			});
		};
		const findings = await runReview(
			{ turnSeq: 1, narrativeText: "艾琳说出了只有王室才知道的秘密。", suspicions, sceneCard: validCard(ids) },
			{ storyDb: story, cwd: dir, executor },
		);
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.kind, "ooc");
		assert.equal(findings[0]?.severity, "hard");
		assert.ok(captured[0]!.includes("报疑清单"));
		assert.ok(captured[0]!.includes("死者名字「亡者」"));
		assert.ok(captured[0]!.includes("艾琳"), "OOC 判定档案注入");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runReview：重试耗尽 → 返回 []（审查失败放行）", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const records: PipelineEvent[] = [];
		const log = createPipelineEventLog();
		log.on((e) => records.push(e));
		const executor = async () => stubResult({ findings: [{ kind: "bad" }] }); // zod 垃圾
		const findings = await runReview(
			{ turnSeq: 1, narrativeText: "n", suspicions: ["s"], sceneCard: validCard(ids) },
			{ storyDb: story, cwd: dir, executor, eventLog: log },
		);
		assert.deepEqual(findings, []);
		const reviewRecords = records.filter((r) => r.role === "story_review");
		assert.ok(reviewRecords.every((r) => r.ok === false));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("runOversee：成功返回 note；重试耗尽返回 null", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);
		const note: OverseeNote = {
			pacing: "节奏偏快",
			open_threads: ["井盖符文"],
			suggestions: ["埋下渡船伏笔"],
			phase_advice: { action: "start", name: "第一章", goals: "离开王城" },
		};
		const ok = await runOversee(
			{ turnSeq: 1, recentNarratives: [], sceneCard: validCard(ids) },
			{ storyDb: story, cwd: dir, executor: async () => stubResult(note) },
		);
		assert.deepEqual(ok, note);

		const nullResult = await runOversee(
			{ turnSeq: 1, recentNarratives: [], sceneCard: validCard(ids) },
			{ storyDb: story, cwd: dir, executor: async () => stubResult({ pacing: 123 }) }, // zod 垃圾
		);
		assert.equal(nullResult, null);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 渲染器
// ---------------------------------------------------------------------------

test("渲染器：renderSceneCardForNarrator / renderOverseeNote / renderRevisionRequest", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const ids = seedStoryStageStory(story);

		const sceneText = renderSceneCardForNarrator(validCard(ids), story);
		assert.ok(sceneText.includes("导演场景卡，玩家不可见"));
		assert.ok(sceneText.includes("王城"));
		assert.ok(sceneText.includes(`艾琳#${ids.onstageId}`));
		assert.ok(sceneText.includes("需离线推演"));
		assert.ok(sceneText.includes("重大事件轮: 否"));

		const note: OverseeNote = {
			pacing: "节奏偏快",
			open_threads: ["井盖符文"],
			suggestions: ["埋下渡船伏笔"],
			phase_advice: { action: "start", name: "第一章", goals: "离开王城" },
		};
		const noteText = renderOverseeNote(note);
		assert.ok(noteText.includes("全统筹批注，玩家不可见"));
		assert.ok(noteText.includes("井盖符文"));
		assert.ok(noteText.includes("埋下渡船伏笔"));
		assert.ok(noteText.includes("开启「第一章」"));

		const revisionText = renderRevisionRequest(
			["场景卡在场 NPC 亡者 status=dead"],
			[{ kind: "ooc", description: "言行矛盾", severity: "hard" }],
		);
		assert.ok(revisionText.includes("[硬冲突]"));
		assert.ok(revisionText.includes("[hard]"));
		assert.ok(revisionText.includes("ooc"));
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
