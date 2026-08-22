// 卡包 seed 与 migration 接入单测（创作规划 §4.1 条目 seed DB + §8 决策行「卡包 SQL 通道」）：
// characters card_ref 幂等不覆盖 / locations parent 父子先种父再种子 / seed.sql 执行 /
// migration 幂等重跑 / 多包共存（各自前缀表 + 各自条目 seed）。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { characterEntry, cleanupTempDir, createPack, entryYaml, locationEntry, makeTempDir } from "./fixtures/pack-fixtures.ts";
import { loadPacks } from "../src/pack/loader.ts";
import { packMigrations } from "../src/pack/seed.ts";
import { hasMigration, migrate } from "../src/db/migrate.ts";
import { openStoryDb } from "../src/db/story-db.ts";

test("seed：characters 条目自动 seed npcs（card_ref = 包名:条目id，status='alive'）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			entries: [{ type: "characters", id: "shen-qiu", yaml: characterEntry("沈秋") }],
		});
		const packs = loadPacks([dir]);
		const story = openStoryDb(join(root, "story.db"));
		try {
			const applied = migrate(story.rawDb, packMigrations(packs));
			assert.ok(applied.includes("shouling_schema"));
			assert.ok(applied.includes("shouling_seed"));
			assert.ok(hasMigration(story.rawDb, "shouling_seed"));

			const npcs = story.reader.listNpcs();
			assert.equal(npcs.length, 1);
			assert.equal(npcs[0]!.name, "沈秋");
			assert.equal(npcs[0]!.card_ref, "shouling:shen-qiu");
			assert.equal(npcs[0]!.status, "alive");
			// reader.findNpcByCardRef 精确命中
			assert.equal(story.reader.findNpcByCardRef("shouling:shen-qiu")?.id, npcs[0]!.id);
			assert.equal(story.reader.findNpcByCardRef("shouling:nobody"), undefined);
		} finally {
			story.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("seed：card_ref 已存在（演化/手动插入）→ 跳过不覆盖、不重复插入", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			entries: [{ type: "characters", id: "shen-qiu", yaml: characterEntry("沈秋") }],
		});
		const packs = loadPacks([dir]);
		const story = openStoryDb(join(root, "story.db"));
		try {
			// 先手动插入同 card_ref 的 npc（模拟玩家/data 演化出的实体，name 不同）
			story.writer.insertNpc({ name: "演化沈秋", cardRef: "shouling:shen-qiu", status: "dead" });
			migrate(story.rawDb, packMigrations(packs));
			const npcs = story.reader.listNpcs();
			assert.equal(npcs.length, 1, "已存在 card_ref 不重复插入");
			assert.equal(npcs[0]!.name, "演化沈秋", "不覆盖 name（演化优先）");
			assert.equal(npcs[0]!.status, "dead", "不覆盖 status（演化优先）");
		} finally {
			story.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("seed：location parent 父子——先种父再种子，子 parent_id 指向父", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			entries: [
				{ type: "locations", id: "royal-tomb", yaml: locationEntry("皇陵", { parent: "tomb-court" }) },
				{ type: "locations", id: "tomb-court", yaml: locationEntry("陵前广场") },
			],
		});
		const packs = loadPacks([dir]);
		const story = openStoryDb(join(root, "story.db"));
		try {
			migrate(story.rawDb, packMigrations(packs));
			const locations = story.reader.listLocations();
			assert.equal(locations.length, 2);
			const court = locations.find((l) => l.name === "陵前广场");
			const tomb = locations.find((l) => l.name === "皇陵");
			assert.ok(court && tomb, "父子地点均 seed");
			assert.equal(court.parent_id, null);
			assert.equal(tomb.parent_id, court.id);
			assert.equal(tomb.parent_name, "陵前广场");
		} finally {
			story.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("seed：schema.sql + seed.sql 落库（包前缀表）；migration 幂等重跑", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "shouling",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
			schemaSql: "CREATE TABLE IF NOT EXISTS shouling_relics (id INTEGER PRIMARY KEY, name TEXT);\n",
			seedSql: "INSERT INTO shouling_relics (name) VALUES ('玉玺'); INSERT INTO shouling_relics (name) VALUES ('青铜灯');\n",
		});
		const packs = loadPacks([dir]);
		const story = openStoryDb(join(root, "story.db"));
		try {
			const first = migrate(story.rawDb, packMigrations(packs));
			assert.ok(first.includes("shouling_schema"));
			assert.ok(first.includes("shouling_seed"));
			const rows = story.rawDb.prepare("SELECT name FROM shouling_relics ORDER BY name").all() as Array<{ name: string }>;
			// BINARY collation 按码点序：玉(U+7389) < 青(U+9752)
			assert.deepEqual(rows.map((r) => r.name), ["玉玺", "青铜灯"]);

			// 幂等重跑：无新迁移，不重复 seed
			assert.deepEqual(migrate(story.rawDb, packMigrations(packs)), []);
			assert.equal(story.reader.listNpcs().length, 1, "npcs 不重复");
			const count = story.rawDb.prepare("SELECT COUNT(*) AS c FROM shouling_relics").get() as { c: number };
			assert.equal(count.c, 2, "seed.sql 不重复执行");
		} finally {
			story.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("seed：多包共存——各自前缀表 + 各自条目 seed，互不干扰", () => {
	const root = makeTempDir();
	try {
		const a = createPack(root, {
			name: "pack_a",
			entries: [{ type: "characters", id: "hero", yaml: characterEntry("A主角") }],
			schemaSql: "CREATE TABLE IF NOT EXISTS pack_a_items (id INTEGER PRIMARY KEY);\n",
			seedSql: "INSERT INTO pack_a_items (id) VALUES (1);\n",
		});
		const b = createPack(root, {
			name: "pack_b",
			entries: [{ type: "characters", id: "hero", yaml: characterEntry("B主角") }],
			schemaSql: "CREATE TABLE IF NOT EXISTS pack_b_stuff (id INTEGER PRIMARY KEY);\n",
		});
		const packs = loadPacks([a, join(root, "pack_b")]);
		const story = openStoryDb(join(root, "story.db"));
		try {
			const applied = migrate(story.rawDb, packMigrations(packs));
			assert.ok(applied.includes("pack_a_schema"));
			assert.ok(applied.includes("pack_a_seed"));
			assert.ok(applied.includes("pack_b_schema"));
			assert.ok(applied.includes("pack_b_seed"));

			const npcs = story.reader.listNpcs();
			assert.equal(npcs.length, 2);
			assert.ok(npcs.some((n) => n.card_ref === "pack_a:hero" && n.name === "A主角"));
			assert.ok(npcs.some((n) => n.card_ref === "pack_b:hero" && n.name === "B主角"));
			story.rawDb.prepare("SELECT * FROM pack_a_items").all();
			story.rawDb.prepare("SELECT * FROM pack_b_stuff").all();
		} finally {
			story.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("seed：schema.sql 空内容可空跳过（migration 存在但零 SQL）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "empty",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
			schemaSql: "",
		});
		const packs = loadPacks([dir]);
		const story = openStoryDb(join(root, "story.db"));
		try {
			const applied = migrate(story.rawDb, packMigrations(packs));
			assert.ok(applied.includes("empty_schema"));
			assert.ok(applied.includes("empty_seed"));
			assert.equal(story.reader.listNpcs().length, 1, "空 schema 不影响条目 seed");
		} finally {
			story.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});
