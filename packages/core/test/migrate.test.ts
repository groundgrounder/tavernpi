// migration 框架单测：幂等、额外命名迁移、失败回滚。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { CORE_MIGRATIONS, hasMigration, migrate, type Migration } from "../src/db/migrate.ts";

test("migrate 首次应用 v1~v4，重复调用幂等（无副作用、返回空）", () => {
	const dir = makeTempDir();
	const dbPath = join(dir, "story.db");
	const db = new DatabaseSync(dbPath);
	try {
		const first = migrate(db);
		assert.deepEqual(first, ["v1_core_schema", "v2_spatial_primitives", "v3_data_status", "v4_turn_log_warnings"]);

		// 幂等：二次调用不再执行任何迁移
		const second = migrate(db);
		assert.deepEqual(second, []);

		// v2 后 §5.1 全量表存在（含空间基元）
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
			(r) => r.name,
		);
		for (const t of [
			"schema_migrations",
			"clock",
			"time_log",
			"events",
			"phases",
			"world_state",
			"npcs",
			"npc_traits",
			"npc_memories",
			"npc_relations",
			"turn_log",
			"directives",
			"locations",
			"location_log",
			"data_status",
		]) {
			assert.ok(tables.includes(t), `表 ${t} 应存在`);
		}
		// v2 旧表补列
		const npcCols = (db.prepare("PRAGMA table_info(npcs)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.ok(npcCols.includes("current_location"), "npcs.current_location 应存在");
		const eventCols = (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.ok(eventCols.includes("location_id"), "events.location_id 应存在");
		// v4 turn_log.warnings 补列
		const turnLogCols = (db.prepare("PRAGMA table_info(turn_log)").all() as Array<{ name: string }>).map((c) => c.name);
		assert.ok(turnLogCols.includes("warnings"), "turn_log.warnings 应存在");
		// snapshots 不在 story.db（§3.1：独立 snapshots.db）
		assert.ok(!tables.includes("snapshots"), "snapshots 表不应存在于 story.db");
	} finally {
		db.close();
		cleanupTempDir(dir);
	}
});

test("migrate 注册额外命名迁移：仅执行未应用的，且顺序在 core 之后", () => {
	const dir = makeTempDir();
	const db = new DatabaseSync(join(dir, "story.db"));
	try {
		const extra: Migration = {
			name: "card_pack_v1",
			up: (d) => d.exec("CREATE TABLE IF NOT EXISTS card_pack_v1 (id INTEGER PRIMARY KEY, note TEXT)"),
		};
		const applied = migrate(db, [extra]);
		assert.deepEqual(applied, ["v1_core_schema", "v2_spatial_primitives", "v3_data_status", "v4_turn_log_warnings", "card_pack_v1"]);
		assert.ok(hasMigration(db, "card_pack_v1"));

		// 再次执行（含同额外迁移）不再应用任何
		assert.deepEqual(migrate(db, [extra]), []);

		// 新注册的另一个迁移只补应用它自己
		const extra2: Migration = {
			name: "card_pack_v2",
			up: (d) => d.exec("CREATE TABLE IF NOT EXISTS card_pack_v2 (id INTEGER PRIMARY KEY)"),
		};
		assert.deepEqual(migrate(db, [extra2]), ["card_pack_v2"]);
	} finally {
		db.close();
		cleanupTempDir(dir);
	}
});

test("migrate 失败回滚：失败的迁移不记入 schema_migrations，已建表一并回滚", () => {
	const dir = makeTempDir();
	const db = new DatabaseSync(join(dir, "story.db"));
	try {
		const bad: Migration = {
			name: "bad_migration",
			// 故意失败：先建表，再抛错 —— 验证事务回滚
			up: (d) => {
				d.exec("CREATE TABLE bad_table (id INTEGER PRIMARY KEY)");
				throw new Error("boom");
			},
		};
		assert.throws(() => migrate(db, [bad]), /boom/);
		assert.ok(!hasMigration(db, "bad_migration"), "失败的迁移不应被记录");

		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
			(r) => r.name,
		);
		assert.ok(!tables.includes("bad_table"), "失败迁移建的表应回滚");
	} finally {
		db.close();
		cleanupTempDir(dir);
	}
});

test("CORE_MIGRATIONS 每个名称唯一（防重名跳过）", () => {
	const names = CORE_MIGRATIONS.map((m) => m.name);
	assert.equal(new Set(names).size, names.length);
});
