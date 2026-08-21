// data 变更集单测：zod 形状校验、语义校验各问题类、applyChangeset 全字段逐表断言、
// SAVEPOINT 嵌套路径（外层事务内含 location_moves）、校验失败零写入原子性。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import { DEFAULT_STORY_CLOCK } from "../src/db/types.ts";
import { applyChangeset, changesetZodSchema, filterConflictingItems, isReservedWorldStateKey, validateChangesetSemantics, type Changeset } from "../src/pipeline/changeset.ts";

function openTempStory(dir: string): StoryDb {
	return openStoryDb(join(dir, "story.db"));
}

/** 种一个带基础事实的库：默认 clock + 地点「王城」+ NPC 罗德/多恩 + 未结束阶段「序章」。 */
function seedStory(story: StoryDb): { rodId: number; dohnId: number } {
	story.writer.insertLocation({ name: "王城", detail: "主城" });
	const rod = story.writer.insertNpc({ name: "罗德" });
	const dohn = story.writer.insertNpc({ name: "多恩" });
	story.writer.insertPhase({ name: "序章", startedTurn: 1, goals: "开场" });
	return { rodId: rod.id, dohnId: dohn.id };
}

// ---------------------------------------------------------------------------
// zod 形状校验
// ---------------------------------------------------------------------------

test("changesetZodSchema：形状错误收集（非字符串/缺必填/类型错）", () => {
	const bad = {
		events: [{ summary: 123 }], // summary 非字符串
		npc_updates: [{ npc_id: "abc" }], // npc_id 非 int
		time_advance: { to_time: "" }, // to_time 空串
		location_moves: [{ subject: "player", to_location_name: "" }],
		world_state: [{ key: "k", value: 42 }],
	};
	const result = changesetZodSchema.safeParse(bad);
	assert.equal(result.success, false);
	assert.ok(result.success === false && result.error.issues.length >= 5, "应收集全部形状问题");
});

test("changesetZodSchema：缺省数组补默认空数组，合法输入通过", () => {
	const parsed = changesetZodSchema.safeParse({ time_advance: { to_time: "0000-01-02" } });
	assert.equal(parsed.success, true);
	if (parsed.success) {
		assert.deepEqual(parsed.data.events, []);
		assert.deepEqual(parsed.data.new_locations, []);
		assert.deepEqual(parsed.data.npc_updates, []);
		assert.equal(parsed.data.time_advance?.to_time, "0000-01-02");
	}
});

// ---------------------------------------------------------------------------
// 语义校验
// ---------------------------------------------------------------------------

test("validateChangesetSemantics：未知地点 / 未知 npc / 时间倒流 / 保留键 / phase_end 未匹配", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStory(story);
		story.writer.advanceClock({ turnSeq: 1, toTime: "0000-01-02" }); // 当前 0000-01-02

		const cs = changesetZodSchema.parse({
			events: [{ summary: "x", location_name: "不存在的地方" }],
			location_moves: [
				{ subject: "npc:999", to_location_name: "王城" },
				{ subject: "乱写", to_location_name: "王城" },
			],
			npc_updates: [{ npc_id: 999, relations: [{ other_npc_id: 888, disposition: 0 }] }],
			time_advance: { to_time: "0000-01-01", span_note: "倒流" },
			world_state: [{ key: "player_location", value: "3" }],
			phase_end: { name: "不存在的阶段" },
		});
		const problems = validateChangesetSemantics(story, cs);
		assert.ok(problems.length >= 7, `应收集全部问题（实际 ${problems.length}）`);
		assert.ok(problems.some((p) => p.message.includes("不存在的地方")), "未知地点");
		assert.ok(problems.some((p) => p.message.includes("引用不存在的 NPC #999")), "subject 引用未知 npc");
		assert.ok(problems.some((p) => p.message.includes("subject 格式非法")), "subject 格式非法");
		assert.ok(problems.some((p) => p.message.includes("npc_updates.npc_id 不存在")), "npc_id 未知");
		assert.ok(problems.some((p) => p.message.includes("other_npc_id 不存在")), "other_npc_id 未知");
		assert.ok(problems.some((p) => p.message.includes("早于当前故事时间")), "时间倒流");
		assert.ok(problems.some((p) => p.message.includes("保留键")), "player_location 保留键");
		assert.ok(problems.some((p) => p.message.includes("phase_end.name")), "phase_end 未匹配");
		// per-item 粒度：item 是变更集内路径标识
		assert.ok(problems.some((p) => p.item === "events[0]"), "events[0] 路径标识");
		assert.ok(problems.some((p) => p.item === "npc_updates[0].relations[0]"), "嵌套关系路径标识");
		assert.ok(problems.some((p) => p.item === "time_advance"), "顶层字段路径标识");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("validateChangesetSemantics：new_locations 先登记后引用可通过；同日推进（相等）允许", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStory(story);
		const cs = changesetZodSchema.parse({
			events: [{ summary: "进庭院", location_name: "庭院" }], // 庭院在同集 new_locations 登记
			new_locations: [{ name: "庭院", parent_name: "王城" }],
			location_moves: [{ subject: "player", to_location_name: "庭院" }],
			new_npcs: [{ name: "艾琳", location_name: "庭院" }],
			time_advance: { to_time: "0000-01-01", span_note: "同日推进（相等允许）" },
		});
		const problems = validateChangesetSemantics(story, cs);
		assert.deepEqual(problems, [], "同集登记后引用与同日时间推进不应报问题");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("validateChangesetSemantics：sys_ 内核保留键禁写（编排器簿记键命名空间）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStory(story);
		const cs = changesetZodSchema.parse({
			world_state: [{ key: "sys_npc_offscreen_last_turn:1", value: "5" }],
		});
		const problems = validateChangesetSemantics(story, cs);
		assert.ok(problems.some((p) => p.message.includes("sys_")), "sys_ 前缀键应被拒");
		// isReservedWorldStateKey 判定
		assert.equal(isReservedWorldStateKey("sys_npc_offscreen_last_turn:3"), true);
		assert.equal(isReservedWorldStateKey("player_location"), true);
		assert.equal(isReservedWorldStateKey("weather"), false);
		assert.equal(isReservedWorldStateKey("sys_任意后缀"), true, "前缀匹配只看 sys_ 开头");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// applyChangeset
// ---------------------------------------------------------------------------

test("applyChangeset：全字段应用到临时 story.db 逐表断言", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const { rodId, dohnId } = seedStory(story);

		const cs: Changeset = changesetZodSchema.parse({
			events: [{ summary: "城门洞开", detail: "主角推开了城门", location_name: "王城" }],
			time_advance: { to_time: "0000-01-02", span_note: "一日" },
			new_locations: [{ name: "庭院", parent_name: "王城", detail: "内院" }],
			location_moves: [{ subject: "player", to_location_name: "王城", note: "进城" }],
			new_npcs: [{ name: "艾琳", status: "alive", location_name: "王城" }],
			npc_updates: [
				{
					npc_id: rodId,
					status: "alive",
					memories: [{ kind: "event", content: "见过主角", salience: 1 }],
					traits: [{ trait: "勇敢", weight: 0.8, source: "narrative" }],
					relations: [{ other_npc_id: dohnId, disposition: 30 }],
				},
			],
			world_state: [{ key: "weather", value: "晴" }],
			phase_start: { name: "第一章", goals: "出城" },
			phase_end: { name: "序章" },
		});

		const summary = applyChangeset(story, cs, { turnSeq: 1, createdEntryId: "entry-1" });

		assert.deepEqual(summary, {
			events: 1,
			newLocations: 1,
			newNpcs: 1,
			npcUpdates: 1,
			locationMoves: 2, // 玩家进城 + 艾琳落位
			worldState: 1,
			timeAdvanced: true,
			phaseStarted: 1,
			phaseEnded: 1,
		});

		// events（location_id 解析到王城）
		const events = story.reader.listEvents();
		assert.equal(events.length, 1);
		assert.equal(events[0]?.summary, "城门洞开");
		const wangCheng = story.reader.listLocations().find((l) => l.name === "王城");
		assert.equal(events[0]?.location_id, wangCheng?.id);
		assert.equal(events[0]?.created_entry_id, "entry-1");

		// locations（庭院.parent = 王城）
		const tingYuan = story.reader.listLocations().find((l) => l.name === "庭院");
		assert.equal(tingYuan?.parent_id, wangCheng?.id);

		// npcs（艾琳落位王城）
		const aiLin = story.reader.listNpcs().find((n) => n.name === "艾琳");
		assert.ok(aiLin, "艾琳应已登记");
		assert.equal(aiLin?.current_location, wangCheng?.id);

		// npc_updates（罗德：记忆/特征/关系）
		const rod = story.reader.getNpc(rodId);
		assert.equal(rod.memories.length, 1);
		assert.equal(rod.memories[0]?.content, "见过主角");
		assert.equal(rod.traits.length, 1);
		assert.equal(rod.traits[0]?.trait, "勇敢");
		assert.equal(rod.relations.length, 1);
		assert.equal(rod.relations[0]?.npc_b, dohnId);

		// location_log：玩家 + 艾琳两条
		assert.equal(story.reader.listLocationLog().length, 2);

		// world_state
		assert.equal(story.reader.listWorldState().find((w) => w.key === "weather")?.value, "晴");

		// phases：第一章 active，序章 ended
		const phases = story.reader.listPhases();
		assert.ok(phases.some((p) => p.name === "第一章" && p.ended_turn === null));
		const prologue = phases.find((p) => p.name === "序章");
		assert.equal(prologue?.ended_turn, 1);

		// time_advance 最后：from = 默认 clock，to = 0000-01-02
		assert.equal(story.reader.getClock()?.current_time, "0000-01-02");
		const timeLogs = story.reader.listTimeLog({ fromTurn: 1 });
		assert.equal(timeLogs.length, 1);
		assert.equal(timeLogs[0]?.from_time, DEFAULT_STORY_CLOCK.current_time);
		assert.equal(timeLogs[0]?.to_time, "0000-01-02");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("applyChangeset：外层事务内调用（SAVEPOINT 嵌套路径）不炸，location_log 正常写入", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStory(story);
		const cs = changesetZodSchema.parse({
			location_moves: [{ subject: "player", to_location_name: "王城" }],
			time_advance: { to_time: "0000-01-02" },
		});
		// 外层 transaction 包裹：applyChangeset 内部 transaction() 命中 isTransaction → SAVEPOINT
		const outer = story.writer.transaction(() => {
			const summary = applyChangeset(story, cs, { turnSeq: 1 });
			assert.equal(summary.locationMoves, 1);
		});
		assert.equal(outer, undefined);
		assert.equal(story.reader.listLocationLog().length, 1);
		assert.equal(story.reader.getClock()?.current_time, "0000-01-02");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("applyChangeset：语义校验失败 → 抛错且零写入（原子性）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStory(story);
		const cs = changesetZodSchema.parse({
			events: [{ summary: "x", location_name: "未知地点" }],
			time_advance: { to_time: "0000-01-02" },
		});
		const eventsBefore = story.reader.listEvents().length;
		const locationsBefore = story.reader.listLocations().length;
		assert.throws(() => applyChangeset(story, cs, { turnSeq: 1 }), /变更集校验失败/);
		assert.equal(story.reader.listEvents().length, eventsBefore, "events 零写入");
		assert.equal(story.reader.listLocations().length, locationsBefore, "locations 零写入");
		assert.equal(story.reader.listTimeLog().length, 0, "time_log 零写入");
		assert.equal(story.reader.getClock()?.current_time, DEFAULT_STORY_CLOCK.current_time, "clock 未动");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// filterConflictingItems（§6.3 strictDrop：硬冲突项剔除，其余照落）
// ---------------------------------------------------------------------------

test("filterConflictingItems：按索引剔除数组元素并重排，顶层字段整体剔除", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		seedStory(story);
		const cs = changesetZodSchema.parse({
			events: [
				{ summary: "好事件1" },
				{ summary: "坏事件（未知地点）", location_name: "不存在的地方" },
				{ summary: "好事件2" },
				{ summary: "坏事件2（未知地点）", location_name: "又不存在" },
			],
			location_moves: [{ subject: "player", to_location_name: "王城" }],
			time_advance: { to_time: "0000-00-30", span_note: "倒流" }, // 顶层字段问题（早于当前 0000-01-01）
			world_state: [{ key: "weather", value: "晴" }],
		});
		const problems = validateChangesetSemantics(story, cs);
		assert.ok(problems.some((p) => p.item === "events[1]"));
		assert.ok(problems.some((p) => p.item === "events[3]"));
		assert.ok(problems.some((p) => p.item === "time_advance"));

		const { filtered, dropped } = filterConflictingItems(cs, problems);
		// 剔除 events[1]/events[3]，保留 events[0]/events[2] 并重排
		assert.deepEqual(
			filtered.events.map((e) => e.summary),
			["好事件1", "好事件2"],
		);
		assert.equal(filtered.time_advance, undefined, "time_advance 顶层字段整体剔除");
		assert.equal(filtered.location_moves.length, 1, "无问题字段保留");
		assert.equal(filtered.world_state.length, 1, "无问题字段保留");
		// dropped 含被剔除项
		assert.deepEqual(
			dropped.map((d) => d.item).sort(),
			["events[1]", "events[3]", "time_advance"].sort(),
		);
		// 入参未被修改（浅拷贝语义）
		assert.equal(cs.events.length, 4);
		assert.ok(cs.time_advance !== undefined);

		// 剔除后的变更集应通过校验并可应用
		assert.deepEqual(validateChangesetSemantics(story, filtered), []);
		const summary = applyChangeset(story, filtered, { turnSeq: 1 });
		assert.equal(summary.events, 2);
		assert.equal(summary.timeAdvanced, false, "time_advance 已剔除");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("filterConflictingItems：npc_updates 嵌套子数组按元素剔除（父元素保留）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const { rodId } = seedStory(story);
		const cs = changesetZodSchema.parse({
			npc_updates: [
				{
					npc_id: rodId,
					memories: [{ kind: "event", content: "好记忆" }],
					relations: [
						{ other_npc_id: 999, disposition: 0 }, // 坏关系（未知 NPC）
						{ other_npc_id: rodId, disposition: 50 },
					],
				},
			],
		});
		const problems = validateChangesetSemantics(story, cs);
		assert.ok(problems.some((p) => p.item === "npc_updates[0].relations[0]"));

		const { filtered, dropped } = filterConflictingItems(cs, problems);
		// 父元素保留，坏关系被剔除
		assert.equal(filtered.npc_updates.length, 1);
		assert.equal(filtered.npc_updates[0]!.memories?.length, 1, "好记忆保留");
		assert.deepEqual(
			filtered.npc_updates[0]!.relations?.map((r) => r.other_npc_id),
			[rodId],
			"坏关系剔除后重排",
		);
		assert.deepEqual(dropped.map((d) => d.item), ["npc_updates[0].relations[0]"]);
		// 剔除后通过校验并可应用
		assert.deepEqual(validateChangesetSemantics(story, filtered), []);
		const summary = applyChangeset(story, filtered, { turnSeq: 1 });
		assert.equal(summary.npcUpdates, 1);
		assert.equal(story.reader.getNpc(rodId).relations.length, 1);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
