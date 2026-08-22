// createStory 单测（创作规划 §4.1 M5 定稿：卡包校验 → SQL+seed 迁移 → story.yaml 消费 →
// 开场白首轮 + turn_log 0 + 初始快照 → story.meta.json）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	characterEntry,
	cleanupTempDir,
	createPack,
	entryYaml,
	locationEntry,
	makeTempDir,
} from "./fixtures/pack-fixtures.ts";
import { createStory, type StoryMetaFile } from "../src/story.ts";

const STORY_YAML = [
	"title: 守陵人",
	"calendar: 大雍历",
	"granularity: elastic",
	"opening: 夜幕低垂，你踏入王陵。",
	"defaultStyle: 冷峻简练",
	"",
].join("\n");

function shoulingPack(root: string): string {
	return createPack(root, {
		name: "shouling",
		story: STORY_YAML,
		entries: [
			{
				type: "characters",
				id: "shen-qiu",
				yaml: characterEntry("沈秋", { refs: ["location:royal-tomb"] }),
			},
			{ type: "locations", id: "royal-tomb", yaml: locationEntry("王陵") },
			{
				type: "locations",
				id: "tomb-passage",
				yaml: locationEntry("墓道", { parent: "royal-tomb" }),
			},
		],
		schemaSql: "CREATE TABLE IF NOT EXISTS shouling_favor (npc_ref TEXT PRIMARY KEY, favor INTEGER);\n",
		seedSql: "INSERT OR IGNORE INTO shouling_favor (npc_ref, favor) VALUES ('shouling:shen-qiu', 0);\n",
	});
}

test("createStory：story.yaml 历法/粒度写 clock 初值", async () => {
	const root = makeTempDir();
	try {
		const packDir = shoulingPack(root);
		const created = await createStory({ storiesRoot: join(root, "stories"), packDirs: [packDir], cwd: root });
		try {
			const clock = created.storyState.storyDb.reader.getClock();
			assert.equal(clock?.calendar, "大雍历");
			assert.equal(clock?.granularity, "elastic");
		} finally {
			created.storyState.storyDb.close();
			created.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("createStory：opening → session 根 assistant 消息 + turn_log(0) + 初始快照绑定", async () => {
	const root = makeTempDir();
	try {
		const packDir = shoulingPack(root);
		const created = await createStory({ storiesRoot: join(root, "stories"), packDirs: [packDir], cwd: root });
		try {
			// session 根 assistant 消息
			const messages = created.sessionManager
				.getEntries()
				.filter((e) => e.type === "message") as Array<{
				id: string;
				parentId: string | null;
				message: { role: string; content?: unknown };
			}>;
			assert.equal(messages.length, 1);
			assert.equal(messages[0]!.message.role, "assistant");
			assert.equal(messages[0]!.parentId, null, "开场白是 session 树根");
			const content = messages[0]!.message.content as Array<{ type: string; text?: string }>;
			assert.equal(content[0]!.text, "夜幕低垂，你踏入王陵。");

			// turn_log turnSeq=0
			const turns = created.storyState.storyDb.reader.getTurnLog();
			assert.equal(turns.length, 1);
			assert.equal(turns[0]!.turn_seq, 0);
			assert.equal(turns[0]!.narrative_text, "夜幕低垂，你踏入王陵。");
			assert.equal(turns[0]!.session_entry_id, messages[0]!.id);

			// 初始快照绑定 opening entry
			const snaps = created.storyState.snapshotsDb.listSnapshots();
			assert.equal(snaps.length, 1);
			assert.equal(snaps[0]!.turn_seq, 0);
			assert.equal(snaps[0]!.session_entry_id, messages[0]!.id);
		} finally {
			created.storyState.storyDb.close();
			created.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("createStory：story.meta.json 内容（title/packs/defaultStyle/createdAt）", async () => {
	const root = makeTempDir();
	try {
		const packDir = shoulingPack(root);
		const created = await createStory({ storiesRoot: join(root, "stories"), packDirs: [packDir], cwd: root });
		try {
			const meta = JSON.parse(
				readFileSync(join(created.storyDir, "story.meta.json"), "utf8"),
			) as StoryMetaFile;
			assert.equal(meta.title, "守陵人");
			assert.equal(meta.defaultStyle, "冷峻简练");
			assert.equal(meta.packs.length, 1);
			assert.equal(meta.packs[0]!.name, "shouling");
			assert.equal(meta.packs[0]!.dir, packDir);
			assert.equal(meta.packs[0]!.version, "0.0.0");
			assert.ok(typeof meta.createdAt === "string" && meta.createdAt.length > 0);
		} finally {
			created.storyState.storyDb.close();
			created.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("createStory：多包 migration——自建表/条目 seed/card_ref/location parent", async () => {
	const root = makeTempDir();
	try {
		const packA = shoulingPack(root);
		const packB = createPack(root, {
			name: "minipack",
			entries: [{ type: "characters", id: "a-qing", yaml: characterEntry("阿青") }],
			schemaSql: "CREATE TABLE IF NOT EXISTS minipack_tokens (id INTEGER PRIMARY KEY);\n",
		});
		const created = await createStory({ storiesRoot: join(root, "stories"), packDirs: [packA, packB], cwd: root });
		try {
			const db = created.storyState.storyDb;
			const npcs = db.reader.listNpcs();
			assert.equal(npcs.length, 2);
			assert.ok(npcs.some((n) => n.card_ref === "shouling:shen-qiu"));
			assert.ok(npcs.some((n) => n.card_ref === "minipack:a-qing"));

			const locations = db.reader.listLocations();
			assert.equal(locations.length, 2);
			const passage = locations.find((l) => l.name === "墓道");
			const tomb = locations.find((l) => l.name === "王陵");
			assert.ok(passage && tomb);
			assert.equal(passage.parent_id, tomb.id);

			const favor = db.rawDb.prepare("SELECT npc_ref, favor FROM shouling_favor").all() as Array<{
				npc_ref: string;
				favor: number;
			}>;
			assert.equal(favor.length, 1);
			assert.equal(favor[0]!.npc_ref, "shouling:shen-qiu");
			assert.equal(favor[0]!.favor, 0);
			db.rawDb.prepare("SELECT * FROM minipack_tokens").all();
		} finally {
			created.storyState.storyDb.close();
			created.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("createStory：无包故事正常创建（零注入产物）", async () => {
	const root = makeTempDir();
	try {
		const created = await createStory({ storiesRoot: join(root, "stories"), packDirs: [], cwd: root });
		try {
			assert.equal(created.packs.length, 0);
			assert.equal(created.storyState.storyDb.reader.listNpcs().length, 0);
			assert.equal(created.storyState.storyDb.reader.getTurnLog().length, 0);
			const meta = JSON.parse(
				readFileSync(join(created.storyDir, "story.meta.json"), "utf8"),
			) as StoryMetaFile;
			assert.deepEqual(meta.packs, []);
		} finally {
			created.storyState.storyDb.close();
			created.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});

test("createStory：无 opening → 不拍初始快照、turn_log 空", async () => {
	const root = makeTempDir();
	try {
		const packDir = createPack(root, {
			name: "bare",
			story: "title: 无开场\n",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
		});
		const created = await createStory({ storiesRoot: join(root, "stories"), packDirs: [packDir], cwd: root });
		try {
			assert.equal(created.storyState.storyDb.reader.getTurnLog().length, 0);
			assert.equal(created.storyState.snapshotsDb.listSnapshots().length, 0);
			const messages = created.sessionManager.getEntries().filter((e) => e.type === "message");
			assert.equal(messages.length, 0);
		} finally {
			created.storyState.storyDb.close();
			created.storyState.snapshotsDb.close();
		}
	} finally {
		cleanupTempDir(root);
	}
});
