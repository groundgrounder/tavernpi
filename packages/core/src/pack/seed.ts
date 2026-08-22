// 卡包 SQL 与条目 seed（创作规划 §4.1 M5 定稿 / §8 决策行「卡包 SQL 通道」）。
//
// schema.sql / seed.sql 以命名 migration 接入（与 core 迁移同 schema_migrations 表追踪，
// name = `<包名>_schema` / `<包名>_seed`，幂等有序，见 migrate.ts）。SQL 文本在构建
// migration 时读入（seed 冷：随故事创建定格，不追卡包热更新）。
//
// 条目 seed 在 `<包名>_seed` migration 内做（§4.1 条目 seed DB）：
//   - characters → npcs：card_ref = `包名:条目id`，按 card_ref 查存在性（DbReader.findNpcByCardRef），
//     已存在即跳过不覆盖（玩家与 data 的演化优先）；v0 只插 name + card_ref + status='alive'，
//     其余由 data 演化。
//   - locations → locations 注册表：沿用 writer.insertLocation 按 name 幂等；location 条目
//     data.parent（同包条目 id 引用）先种父再种子，父 location_id 按 name 查。
//
// story.yaml 的 calendar/granularity/opening/defaultStyle 本 lane 只解析进 StoryMeta（loader），
// 消费在 Lane C。

import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Migration } from "../db/migrate.ts";
import { DbReader } from "../db/reader.ts";
import { DbWriter } from "../db/writer.ts";
import type { CollectionEntry, WorldPack } from "./types.ts";

/** 构建卡包命名 migration 序列：每包两项 `<包名>_schema` / `<包名>_seed`（按包序）。 */
export function packMigrations(packs: WorldPack[]): Migration[] {
	const migrations: Migration[] = [];
	for (const pack of packs) {
		const schemaSql = readPackFile(pack.dir, "db/schema.sql");
		const seedSql = readPackFile(pack.dir, "db/seed.sql");
		migrations.push({
			name: `${pack.name}_schema`,
			up: (db) => {
				// 可空跳过：内容为空/缺失不执行（布局校验在加载层做）
				if (schemaSql.trim() !== "") db.exec(schemaSql);
			},
		});
		migrations.push({
			name: `${pack.name}_seed`,
			up: (db) => {
				if (seedSql.trim() !== "") db.exec(seedSql);
				seedPackEntries(db, pack);
			},
		});
	}
	return migrations;
}

/** 读包内文件；缺失返回空串（schema 可空跳过 / seed 可选）。 */
function readPackFile(dir: string, rel: string): string {
	const path = join(dir, rel);
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf-8");
}

// ---------------------------------------------------------------------------
// 条目 seed（在 <包名>_seed migration 的事务内执行）
// ---------------------------------------------------------------------------

function seedPackEntries(db: DatabaseSync, pack: WorldPack): void {
	const reader = new DbReader(db);
	const writer = new DbWriter(db);

	// characters → npcs（card_ref 幂等键：已存在即跳过，不覆盖 name/status）
	for (const entry of pack.entries) {
		if (entry.type !== "character") continue;
		const cardRef = `${pack.name}:${entry.id}`;
		if (reader.findNpcByCardRef(cardRef) !== undefined) continue;
		writer.insertNpc({ name: entry.name, cardRef, status: "alive" });
	}

	// locations → locations 注册表（按 name 幂等；parent 同包引用先种父再种子）
	const locationEntries = pack.entries.filter((e): e is CollectionEntry & { type: "location" } => e.type === "location");
	const idByName = new Map(reader.listLocations().map((l) => [l.name, l.id]));
	for (const entry of orderLocationsParentFirst(locationEntries)) {
		const parentId = resolveLocationParentId(entry, pack, idByName);
		const row = writer.insertLocation({ name: entry.name, parentId, detail: entry.body });
		idByName.set(row.name, row.id);
	}
}

/** 父地点条目 id（data.parent，同包引用）→ 父地点行 id（按 name 查；未登记/断链返回 undefined）。 */
function resolveLocationParentId(
	entry: CollectionEntry,
	pack: WorldPack,
	idByName: Map<string, number>,
): number | undefined {
	const parent = typeof entry.data.parent === "string" ? entry.data.parent : undefined;
	if (parent === undefined) return undefined;
	const parentEntry = pack.entries.find((e) => e.id === parent && e.type === "location");
	if (parentEntry === undefined) return undefined;
	return idByName.get(parentEntry.name);
}

/** 拓扑序：父地点先于子地点（DFS + 环守卫——环时父不可解析，退化为无父插入，不抛）。 */
function orderLocationsParentFirst(entries: CollectionEntry[]): CollectionEntry[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const ordered: CollectionEntry[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (id: string): void => {
		if (visited.has(id) || visiting.has(id)) return;
		const entry = byId.get(id);
		if (entry === undefined) return;
		visiting.add(id);
		const parent = typeof entry.data.parent === "string" ? entry.data.parent : undefined;
		if (parent !== undefined && byId.has(parent)) visit(parent);
		visiting.delete(id);
		visited.add(id);
		ordered.push(entry);
	};
	for (const entry of entries) visit(entry.id);
	return ordered;
}
