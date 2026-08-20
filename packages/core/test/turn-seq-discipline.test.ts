// turn_seq 纪律与读写层单测：缺参报错、clock 单例、写入后可读回、目录布局。

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb, storyDbPath } from "../src/db/story-db.ts";
import { DEFAULT_STORY_CLOCK } from "../src/db/types.ts";

function openTempStory(dir: string, name = "story.db") {
	const story = openStoryDb(join(dir, name));
	return story;
}

test("openStoryDb：WAL 模式 + 外键开启 + 默认 clock 种入", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const journalMode = (story.rawDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
		assert.equal(journalMode.toLowerCase(), "wal");
		const fk = (story.rawDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
		assert.equal(fk, 1);
		assert.deepEqual({ ...story.reader.getClock() }, DEFAULT_STORY_CLOCK);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("故事目录布局：storyDbPath = <storiesRoot>/<session-id>/story.db，open 会创建目录", () => {
	const root = makeTempDir();
	try {
		const path = storyDbPath(root, "session-abc");
		assert.equal(path, join(root, "session-abc", "story.db"));
		assert.ok(!existsSync(path));
		const story = openStoryDb(path);
		assert.ok(existsSync(path), "open 应创建 db 文件");
		assert.ok(existsSync(join(root, "session-abc")), "open 应创建 session 目录");
		story.close();
	} finally {
		cleanupTempDir(root);
	}
});

test("storyDbPath 校验 sessionId 字符集白名单（防路径穿越）", () => {
	const root = makeTempDir();
	try {
		// 合法：A-Za-z0-9_-（pi 的 session id 与 UUID 均在此集合）
		assert.equal(storyDbPath(root, "01a018c8-de42-7b17-95d8-e148756975d7").endsWith("story.db"), true);
		assert.equal(storyDbPath(root, "a_b-c2").includes("../"), false);
		// 非法：路径分隔符 / 点穿越 与空白
		assert.throws(() => storyDbPath(root, "../evil"), /非法 sessionId/);
		assert.throws(() => storyDbPath(root, "a/b"), /非法 sessionId/);
		assert.throws(() => storyDbPath(root, ".."), /非法 sessionId/);
		assert.throws(() => storyDbPath(root, "a b"), /非法 sessionId/);
		assert.throws(() => storyDbPath(root, ""), /非法 sessionId/);
	} finally {
		cleanupTempDir(root);
	}
});

test("turn_seq 纪律：insertEvent 缺 turnSeq 运行时抛错（类型层面已必填，此处验证纵深防御）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const writer = story.writer as unknown as {
			insertEvent: (input: { summary: string }) => unknown;
		};
		// JS 调用缺 turnSeq —— 运行时校验兜底
		assert.throws(() => writer.insertEvent({ summary: "x" }), /turn_seq 纪律/);
		// 非法值同样拒绝
		assert.throws(() =>
			(story.writer as unknown as { insertEvent: (i: { turnSeq: number }) => unknown }).insertEvent({ turnSeq: -1 }),
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("clock 单例约束：直接插入第二行违反 CHECK(id=1)", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		assert.throws(() =>
			story.rawDb.prepare("INSERT INTO clock (id, current_time, calendar, granularity) VALUES (2, ?, ?, ?)").run(
				"x",
				"y",
				"z",
			),
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("upsertClock 是单例安全入口（turn_seq 纪律的显式例外）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		story.writer.upsertClock({ current_time: "0000-02-03", calendar: "default", granularity: "elastic" });
		story.writer.upsertClock({ current_time: "0000-03-04", calendar: "default", granularity: "elastic" });
		const clock = story.reader.getClock();
		assert.equal(clock?.current_time, "0000-03-04");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("recordDataStatus：缺 turnSeq 运行时抛错（turn_seq 纪律覆盖 data_status）", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const writer = story.writer as unknown as {
			recordDataStatus: (input: { turnSeq?: number; status: "ok" | "failed"; attempts: number }) => unknown;
		};
		assert.throws(() => writer.recordDataStatus({ status: "ok", attempts: 1 }), /turn_seq 纪律/);
		assert.throws(() => writer.recordDataStatus({ turnSeq: -1, status: "ok", attempts: 1 }), /turn_seq 纪律/);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("写入后可读回：events / time_log / world_state / npc 复合 / turn_log / directives", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);

		// events
		const ev = story.writer.insertEvent({
			turnSeq: 2,
			summary: "城门洞开",
			detail: "主角推开了城门",
			storyTime: "0000-01-01",
			type: "action",
			participants: "主角",
			location: "王城",
			createdEntryId: "entry-7",
		});
		assert.equal(ev.turn_seq, 2);
		const readBack = story.reader.listEvents({ fromTurn: 2, toTurn: 2 });
		assert.equal(readBack.length, 1);
		// node:sqlite 返回的行是 null-proto 对象，展开为普通对象再比对
		assert.deepEqual({ ...readBack[0] }, ev);

		// time_log + clock 推进（from_time 由 writer 内部读 clock，调用方不可伪造）
		const tl = story.writer.advanceClock({ turnSeq: 2, toTime: "0000-01-02", spanNote: "一夜" });
		assert.equal(tl.turn_seq, 2);
		assert.equal(tl.from_time, DEFAULT_STORY_CLOCK.current_time, "from_time ≡ 写入时 clock 初始值");
		assert.equal(story.reader.getClock()?.current_time, "0000-01-02");
		assert.equal(story.reader.listTimeLog({ fromTurn: 2 }).length, 1);
		// 连续推进：下一次的 from_time ≡ 上一次的 to_time（来源一致由 DB 层保证）
		const tl2 = story.writer.advanceClock({ turnSeq: 3, toTime: "0000-01-05" });
		assert.equal(tl2.from_time, "0000-01-02");

		// world_state 覆盖语义
		story.writer.upsertWorldState({ key: "weather", value: "晴", turnSeq: 2 });
		story.writer.upsertWorldState({ key: "weather", value: "雨", turnSeq: 3 });
		const ws = story.reader.listWorldState();
		assert.equal(ws.length, 1);
		assert.equal(ws[0]?.value, "雨");
		assert.equal(ws[0]?.turn_seq, 3);

		// npc 复合读
		const npc = story.writer.insertNpc({ name: "艾琳", status: "alive" });
		const npc2 = story.writer.insertNpc({ name: "罗德" });
		story.writer.insertNpcTrait({ npcId: npc.id, trait: "勇敢", weight: 0.8, turnSeq: 2 });
		story.writer.insertNpcMemory({ npcId: npc.id, turnSeq: 2, kind: "event", content: "见过主角", salience: 1 });
		story.writer.insertNpcRelation({ npcA: npc.id, npcB: npc2.id, disposition: 30, turnSeq: 2 });
		const composite = story.reader.getNpc(npc.id);
		assert.equal(composite.npc?.name, "艾琳");
		assert.equal(composite.traits.length, 1);
		assert.equal(composite.memories.length, 1);
		assert.equal(composite.relations.length, 1);

		// turn_log 每轮一行（PK turn_seq）
		story.writer.recordTurnLog({
			turnSeq: 2,
			sessionEntryId: "entry-7",
			userInput: "推门",
			narrativeText: "他推开了门。",
		});
		assert.throws(() =>
			story.writer.recordTurnLog({ turnSeq: 2, sessionEntryId: "x", userInput: "y", narrativeText: "z" }),
		);
		assert.equal(story.reader.getTurnLog(2).length, 1);

		// directives status 封闭枚举
		const d = story.writer.insertDirective({ turnSeq: 2, content: "主角必须活下来" });
		assert.equal(d.status, "active");
		assert.throws(() =>
			story.rawDb.prepare("INSERT INTO directives (turn_seq, content, status) VALUES (3, 'x', 'invalid')").run(),
		);
		story.writer.updateDirectiveStatus(d.id, "done");
		assert.equal(story.reader.listDirectives("done").length, 1);
	} finally {
		// 目录清理
		cleanupTempDir(dir);
	}
});

test("外键开启生效：npc_traits 引用不存在的 npc 抛错", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		assert.throws(() =>
			story.writer.insertNpcTrait({ npcId: 999, trait: "t", weight: 0.5, turnSeq: 1 }),
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
