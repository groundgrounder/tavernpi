// Migration 框架（§5.0 schema 版本化的底座）。
// core schema 是命名迁移序列（v1 基础 schema → v2 空间基元）；卡包 schema.sql 后续以
// 「注册额外命名 migration」接入，与 core 迁移同表（schema_migrations）追踪，保证幂等与顺序。
// 既有 v1 库（M1 已交付，已记录 v1_core_schema）open 后原地升 v2；新库 v1→v2 顺序应用。

import { DatabaseSync } from "node:sqlite";
import { CORE_SCHEMA_SQL, CORE_V2_ALTERS, CORE_V2_SPATIAL_SQL } from "./schema.ts";

export interface Migration {
	/** 唯一名称（schema_migrations.name）。同名重复注册会被跳过。 */
	name: string;
	/** 应用该迁移。须自带幂等或事务保护；失败时整个迁移回滚。 */
	up: (db: DatabaseSync) => void;
}

/** schema_migrations 表定义（测试模拟旧库等场景可复用）。 */
export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
`;

/** 列是否存在（ALTER ADD COLUMN 的幂等守卫）。 */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return cols.some((c) => c.name === column);
}

/** core 内置迁移。v1 = §5.1 基础 schema；v2 = 空间基元（§5.1 locations/location_log + 旧表补列）。 */
export const CORE_MIGRATIONS: Migration[] = [
	{ name: "v1_core_schema", up: (db) => db.exec(CORE_SCHEMA_SQL) },
	{
		name: "v2_spatial_primitives",
		up: (db) => {
			db.exec(CORE_V2_SPATIAL_SQL);
			// 旧表补列（新库此处列尚不存在必然执行；旧库若部分残留则守卫跳过）
			for (const alter of CORE_V2_ALTERS) {
				if (!columnExists(db, alter.table, alter.column)) {
					db.exec(alter.sql);
				}
			}
		},
	},
];

/**
 * 应用未执行的迁移（幂等：重复调用无副作用）。
 * @param extraMigrations 卡包/扩展注册的额外命名迁移（按注册顺序在 core 之后执行）。
 * @returns 本次实际应用（新执行）的迁移名列表。
 */
export function migrate(db: DatabaseSync, extraMigrations: Migration[] = []): string[] {
	db.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
	const applied = new Set(
		(db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name),
	);

	const appliedNames: string[] = [];
	for (const migration of [...CORE_MIGRATIONS, ...extraMigrations]) {
		if (applied.has(migration.name)) {
			continue;
		}
		db.exec("BEGIN");
		try {
			migration.up(db);
			db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
				migration.name,
				new Date().toISOString(),
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		appliedNames.push(migration.name);
	}
	return appliedNames;
}

/** 查询某命名迁移是否已应用（供测试与工具使用）。 */
export function hasMigration(db: DatabaseSync, name: string): boolean {
	const row = db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(name);
	return row !== undefined;
}
