// 空间基元（创作规划 §5.1 / §8 决策行）单测：v1→v2 迁移、登记校验、moveSubject 双写与链、
// insertLocation 幂等、工具层 move_to/get_location。全部确定性，无 LLM。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { CORE_SCHEMA_SQL } from "../src/db/schema.ts";
import { hasMigration, migrate, SCHEMA_MIGRATIONS_TABLE_SQL } from "../src/db/migrate.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import { createDbTools } from "../src/db/tools.ts";
import { PLAYER_LOCATION_KEY } from "../src/db/types.ts";

/** 模拟 M1 已交付的 v1 库：v1 全量 schema + v1 migration 记录 + 旧数据。 */
function buildV1Db(dbPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	db.exec(CORE_SCHEMA_SQL);
	db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
	db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('v1_core_schema', ?)").run(
		new Date().toISOString(),
	);
	db.prepare("INSERT INTO npcs (name, card_ref, status) VALUES ('艾琳', NULL, 'alive')").run();
	db.prepare("INSERT INTO events (turn_seq, summary) VALUES (1, '城门洞开')").run();
	return db;
}

function openTempStory(dir: string): StoryDb {
	return openStoryDb(join(dir, "story.db"));
}

const ctx = {} as unknown as ExtensionContext;

// ---------------------------------------------------------------------------
// v1 → v2 迁移
// ---------------------------------------------------------------------------

test("v1 库原地升 v2：旧数据不动、新表/新列齐全、重复 open/migrate 幂等", () => {
	const dir = makeTempDir();
	const dbPath = join(dir, "story.db");
	const db = buildV1Db(dbPath);
	try {
		// 升级：仅补 v2
		const applied = migrate(db);
		assert.deepEqual(applied, ["v2_spatial_primitives"]);
		assert.ok(hasMigration(db, "v2_spatial_primitives"));

		// 新表存在
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
			(r) => r.name,
		);
		assert.ok(tables.includes("locations"), "locations 表应存在");
		assert.ok(tables.includes("location_log"), "location_log 表应存在");

		// 旧表补列 + 旧行默认 NULL
		const npcCols = (db.prepare("PRAGMA table_info(npcs)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.ok(npcCols.includes("current_location"), "npcs.current_location 应存在");
		assert.equal(
			(db.prepare("SELECT current_location FROM npcs WHERE name = '艾琳'").get() as { current_location: number | null }).current_location,
			null,
			"旧 NPC 行 current_location 应为 NULL",
		);
		const eventCols = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.ok(eventCols.includes("location_id"), "events.location_id 应存在");

		// 旧数据不动
		assert.equal((db.prepare("SELECT COUNT(*) AS c FROM npcs").get() as { c: number }).c, 1);
		assert.equal(
			(db.prepare("SELECT summary FROM events WHERE id = 1").get() as { summary: string }).summary,
			"城门洞开",
		);

		// 幂等：重复 migrate 与重开
		assert.deepEqual(migrate(db), []);
		db.close();
		const reopened = openStoryDb(dbPath);
		assert.equal(reopened.reader.listNpcs().length, 1, "重开后旧数据仍在");
		reopened.close();
	} finally {
		try {
			db.close();
		} catch {
			/* 可能已关闭 */
		}
		cleanupTempDir(dir);
	}
});

test("新库（无 v1 记录）直接建到 v2：v1+v2 顺序应用", () => {
	const dir = makeTempDir();
	const db = new DatabaseSync(join(dir, "story.db"));
	try {
		const applied = migrate(db);
		assert.deepEqual(applied, ["v1_core_schema", "v2_spatial_primitives"]);
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
			(r) => r.name,
		);
		assert.ok(tables.includes("locations"));
		assert.ok(tables.includes("location_log"));
	} finally {
		db.close();
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 登记校验（§5.0「地点概念从 DB 来」）
// ---------------------------------------------------------------------------

test("登记校验：moveSubject / insertEvent 引用未登记地点抛错，location_log 不落脏行", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		assert.throws(
			() => story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: 999 }),
			/未登记/,
		);
		assert.throws(() => story.writer.insertEvent({ turnSeq: 1, summary: "s", locationId: 999 }), /未登记/);
		assert.equal(story.reader.listLocationLog().length, 0, "校验失败不得写 location_log");
		assert.equal(story.reader.getPlayerLocation(), undefined, "玩家位置未被污染");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// moveSubject：玩家
// ---------------------------------------------------------------------------

test("moveSubject player：world_state + location_log 双写，from 链正确", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const city = story.writer.insertLocation({ name: "王城" });
		const yard = story.writer.insertLocation({ name: "庭院", parentId: city.id });

		// 首移：from = NULL
		const m1 = story.writer.moveSubject({ turnSeq: 1, subject: "player", toLocationId: city.id, note: "进城" });
		assert.equal(m1.from_location, null);
		assert.equal(m1.to_location, city.id);
		assert.equal(m1.from_location_name, null);
		assert.equal(m1.to_location_name, "王城");

		// world_state 约定键双写
		const ws = story.reader.listWorldState().find((w) => w.key === PLAYER_LOCATION_KEY);
		assert.equal(ws?.value, String(city.id));
		assert.equal(ws?.turn_seq, 1);
		assert.equal(story.reader.getPlayerLocation()?.name, "王城");

		// 再移：from = city → yard，且 parent 名解析
		const m2 = story.writer.moveSubject({ turnSeq: 2, subject: "player", toLocationId: yard.id });
		assert.equal(m2.from_location, city.id);
		assert.equal(m2.to_location, yard.id);
		assert.equal(story.reader.getPlayerLocation()?.name, "庭院");
		assert.equal(story.reader.getPlayerLocation()?.parent_name, "王城");

		// location_log 两条、倒序、链正确
		const logs = story.reader.listLocationLog();
		assert.equal(logs.length, 2);
		assert.equal(logs[0]?.turn_seq, 2);
		assert.equal(logs[0]?.from_location, city.id);
		assert.equal(logs[0]?.from_location_name, "王城");
		assert.equal(logs[1]?.turn_seq, 1);
		assert.equal(logs[1]?.from_location, null);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// moveSubject：NPC
// ---------------------------------------------------------------------------

test("moveSubject npc：npcs.current_location 更新 + location_log；npc 不存在/格式非法抛错", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const city = story.writer.insertLocation({ name: "王城" });
		const npc = story.writer.insertNpc({ name: "艾琳" });

		const m = story.writer.moveSubject({ turnSeq: 1, subject: `npc:${npc.id}`, toLocationId: city.id });
		assert.equal(m.from_location, null);
		assert.equal(m.subject, `npc:${npc.id}`);

		// npcs.current_location 更新 + 复合读解析
		const composite = story.reader.getNpc(npc.id);
		assert.equal(composite.npc?.current_location, city.id);
		assert.equal(composite.npc?.current_location_name, "王城");
		assert.equal(story.reader.listNpcs()[0]?.current_location_name, "王城");

		// npc 不存在
		assert.throws(
			() => story.writer.moveSubject({ turnSeq: 2, subject: "npc:999", toLocationId: city.id }),
			/npc #999 不存在/,
		);
		// subject 格式非法
		assert.throws(
			() => story.writer.moveSubject({ turnSeq: 2, subject: "npc:abc", toLocationId: city.id }),
			/非法 subject/,
		);
		assert.throws(
			() => story.writer.moveSubject({ turnSeq: 2, subject: "bob", toLocationId: city.id }),
			/非法 subject/,
		);
		// 非法/不存在场景不得写 location_log
		assert.equal(story.reader.listLocationLog().length, 1);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// insertLocation 幂等
// ---------------------------------------------------------------------------

test("insertLocation 幂等变体按 name 去重；parent 未登记抛错", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const a = story.writer.insertLocation({ name: "王城", detail: "d1" });
		const b = story.writer.insertLocation({ name: "王城", detail: "不同 detail" });
		assert.equal(a.id, b.id, "同名应去重返回同一 id");
		const rows = story.reader.listLocations();
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.detail, "d1", "已存在则不动原行");

		assert.throws(() => story.writer.insertLocation({ name: "X", parentId: 999 }), /未登记/);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 工具层：get_location / move_to
// ---------------------------------------------------------------------------

test("工具层：move_to 经 provider 拿 turn_seq（模型不接触），get_location 返回玩家位置与地点树", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const city = story.writer.insertLocation({ name: "王城" });
		story.writer.insertLocation({ name: "庭院", parentId: city.id });

		let turn = 0;
		const tools = createDbTools(story, { getCurrentTurnSeq: () => turn });
		const getLocation = tools.find((t) => t.name === "get_location")!;
		const moveTo = tools.find((t) => t.name === "move_to")!;

		// 未注入 provider 时 move_to fail-loud
		const noProviderTools = createDbTools(story);
		const moveToNoProvider = noProviderTools.find((t) => t.name === "move_to")!;
		await assert.rejects(
			moveToNoProvider.execute("c0", { location_id: 1 }, undefined, undefined, ctx),
			/当前轮次未注入/,
		);

		// get_location：玩家未定位时提示
		const g1 = await getLocation.execute("c1", {}, undefined, undefined, ctx);
		const g1Text = (g1.content[0] as { text: string }).text;
		assert.ok(g1Text.includes("玩家尚未定位"), g1Text);
		assert.ok(g1Text.includes("王城"), "地点树应含王城");

		// move_to：turn_seq 由 provider 提供（模型不接触，参数 schema 无 turn_seq）
		turn = 5;
		const paramsSchema = moveTo.parameters as { properties: Record<string, unknown> };
		assert.equal(paramsSchema.properties["turn_seq"], undefined, "move_to schema 不得暴露 turn_seq");
		const m = await moveTo.execute("c3", { location_id: city.id, note: "进城" }, undefined, undefined, ctx);
		assert.equal((m.details as { turn_seq: number }).turn_seq, 5);
		assert.equal(story.reader.getPlayerLocation()?.name, "王城");

		// get_location 现在显示玩家位置
		const g2 = await getLocation.execute("c4", {}, undefined, undefined, ctx);
		const g2Text = (g2.content[0] as { text: string }).text;
		assert.ok(g2Text.includes("当前玩家位置: 王城"), g2Text);

		// 未登记地点 move_to 拒绝
		await assert.rejects(
			moveTo.execute("c5", { location_id: 999 }, undefined, undefined, ctx),
			/未登记/,
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
