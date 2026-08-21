// data_status 表单测：v3 迁移应用与幂等、旧 v2 库原地升级、recordDataStatus upsert、
// markFailedTurnsCompensated、status CHECK 约束。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { CORE_V2_ALTERS, CORE_SCHEMA_SQL, CORE_V2_SPATIAL_SQL } from "../src/db/schema.ts";
import { hasMigration, migrate, SCHEMA_MIGRATIONS_TABLE_SQL } from "../src/db/migrate.ts";
import { openStoryDb } from "../src/db/story-db.ts";

test("v3 迁移：全新库顺序应用含 v3_data_status，重复调用幂等", () => {
	const dir = makeTempDir();
	try {
		const db = new DatabaseSync(join(dir, "story.db"));
		const applied = migrate(db);
		assert.deepEqual(applied, ["v1_core_schema", "v2_spatial_primitives", "v3_data_status", "v4_turn_log_warnings"]);
		assert.ok(hasMigration(db, "v3_data_status"));
		assert.deepEqual(migrate(db), [], "重复调用幂等");
		// data_status 表存在且可读写
		db.prepare("INSERT INTO data_status (turn_seq, status, attempts) VALUES (1, 'ok', 1)").run();
		const row = db.prepare("SELECT turn_seq, status, attempts, error FROM data_status WHERE turn_seq = 1").get() as {
			status: string;
		};
		assert.equal(row.status, "ok");
		db.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("v3 迁移：旧 v2 库原地升级（补 v3+v4），openStoryDb 重开自动升级", () => {
	const dir = makeTempDir();
	const dbPath = join(dir, "story.db");
	const db = new DatabaseSync(dbPath);
	try {
		// 模拟 M1/M2-P1 已交付的 v2 库
		db.exec(CORE_SCHEMA_SQL);
		db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
		db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('v1_core_schema', ?)").run(
			new Date().toISOString(),
		);
		db.exec(CORE_V2_SPATIAL_SQL);
		for (const alter of CORE_V2_ALTERS) db.exec(alter.sql);
		db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES ('v2_spatial_primitives', ?)").run(
			new Date().toISOString(),
		);

		const applied = migrate(db);
		assert.deepEqual(applied, ["v3_data_status", "v4_turn_log_warnings"], "旧 v2 库补 v3+v4");
		db.close();

		// openStoryDb 重开：v3/v4 已记录，无新迁移；listDataStatus 可读、turn_log.warnings 可写
		const story = openStoryDb(dbPath);
		assert.deepEqual(story.reader.listDataStatus(), []);
		story.writer.recordTurnLog({ turnSeq: 1, sessionEntryId: "e1", userInput: "u", narrativeText: "n" });
		story.writer.setTurnLogWarnings(1, "轻检留痕");
		assert.equal(story.reader.getTurnLog(1)[0]?.warnings, "轻检留痕");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("recordDataStatus：upsert（同轮覆盖），listDataStatus 按 turn_seq 升序", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.recordDataStatus({ turnSeq: 2, status: "failed", attempts: 3, error: "校验失败" });
		story.writer.recordDataStatus({ turnSeq: 1, status: "ok", attempts: 1 });
		// 同轮 upsert：failed → ok，attempts 更新，error 清空
		story.writer.recordDataStatus({ turnSeq: 2, status: "ok", attempts: 4 });

		const rows = story.reader.listDataStatus();
		assert.equal(rows.length, 2);
		assert.equal(rows[0]?.turn_seq, 1);
		assert.equal(rows[0]?.status, "ok");
		assert.equal(rows[1]?.turn_seq, 2);
		assert.equal(rows[1]?.status, "ok");
		assert.equal(rows[1]?.attempts, 4);
		assert.equal(rows[1]?.error, null, "成功时 error 置空");
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("markFailedTurnsCompensated：failed 批量标记 compensated，ok 不动，返回受影响行数", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.recordDataStatus({ turnSeq: 1, status: "failed", attempts: 3 });
		story.writer.recordDataStatus({ turnSeq: 2, status: "failed", attempts: 2 });
		story.writer.recordDataStatus({ turnSeq: 3, status: "ok", attempts: 1 });

		const changed = story.writer.markFailedTurnsCompensated();
		assert.equal(changed, 2);

		const rows = story.reader.listDataStatus();
		assert.equal(rows[0]?.status, "compensated");
		assert.equal(rows[1]?.status, "compensated");
		assert.equal(rows[2]?.status, "ok");
		// 再调幂等：无 failed 可标记
		assert.equal(story.writer.markFailedTurnsCompensated(), 0);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("data_status status CHECK 约束：非法值被 SQLite 拒绝（防手写 SQL 绕过类型层）", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		assert.throws(() =>
			story.rawDb.prepare("INSERT INTO data_status (turn_seq, status, attempts) VALUES (1, 'bogus', 1)").run(),
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});
