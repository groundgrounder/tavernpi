// PackCache 热更新单测（创作规划 §8 决策行「设定集热更新」：注入热、seed 冷，2026-08-22 定案）：
// 首次加载 / mtime 变化重载 / 无变化缓存命中（对象引用不变）/ 校验失败回退上次成功快照 + warning /
// 首次加载失败直接抛 PackLoadError。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { characterEntry, cleanupTempDir, createPack, entryYaml, makeTempDir, writeFile } from "./fixtures/pack-fixtures.ts";
import { PackCache } from "../src/pack/cache.ts";
import { PackLoadError } from "../src/pack/types.ts";

test("PackCache：首次加载 + 无变化时缓存命中（返回同一 packs 引用，warnings 空）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("原名") }],
		});
		const cache = new PackCache([dir]);
		const first = cache.getPacks();
		assert.deepEqual(first.warnings, []);
		assert.equal(first.packs[0]!.entries[0]!.name, "原名");

		const second = cache.getPacks();
		assert.equal(second.packs, first.packs, "无变化应返回同一 packs 引用（缓存命中）");
		assert.deepEqual(second.warnings, []);
	} finally {
		cleanupTempDir(root);
	}
});

test("PackCache：mtime 变化（改条目/story/sql）→ 重载新内容", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("原名") }],
		});
		const cache = new PackCache([dir]);
		assert.equal(cache.getPacks().packs[0]!.entries[0]!.name, "原名");

		// 改条目：注入热，下一轮生效
		writeFile(dir, "collection/characters/a.yaml", characterEntry("新名"));
		const afterEntry = cache.getPacks();
		assert.equal(afterEntry.packs[0]!.entries[0]!.name, "新名");
		assert.deepEqual(afterEntry.warnings, []);

		// 改 story.yaml
		writeFile(dir, "story.yaml", "title: 改题\n");
		assert.equal(cache.getPacks().packs[0]!.story.title, "改题");
	} finally {
		cleanupTempDir(root);
	}
});

test("PackCache：重载校验失败 → 回退上次成功快照 + warning（不阻塞），修好后自动恢复", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("稳定名") }],
		});
		const cache = new PackCache([dir]);
		const first = cache.getPacks();
		assert.equal(first.packs[0]!.entries[0]!.name, "稳定名");

		// 破坏条目（坏 YAML）→ 回退
		writeFile(dir, "collection/characters/a.yaml", "type: character\nname: [坏\n");
		const fallback = cache.getPacks();
		assert.equal(fallback.packs, first.packs, "回退到上次成功快照（同一引用）");
		assert.equal(fallback.packs[0]!.entries[0]!.name, "稳定名");
		assert.ok(fallback.warnings.length > 0, "应有回退 warning");
		assert.match(fallback.warnings[0]!, /回退上次成功加载的快照/);

		// 修复 → 自动恢复，warnings 清空
		writeFile(dir, "collection/characters/a.yaml", characterEntry("修复名"));
		const recovered = cache.getPacks();
		assert.equal(recovered.packs[0]!.entries[0]!.name, "修复名");
		assert.deepEqual(recovered.warnings, []);
	} finally {
		cleanupTempDir(root);
	}
});

test("PackCache：首次加载失败直接抛 PackLoadError（无快照可回退）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: "type: character\nname: [坏\n" }],
		});
		const cache = new PackCache([dir]);
		assert.throws(() => cache.getPacks(), PackLoadError);
	} finally {
		cleanupTempDir(root);
	}
});

test("PackCache：加载语义错误（断链/前缀违规）同样回退 + warning（校验失败 = 加载层全部校验）", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
			schemaSql: "CREATE TABLE p_x (id INTEGER);\n",
		});
		const cache = new PackCache([dir]);
		assert.equal(cache.getPacks().packs[0]!.entries.length, 1);

		// 前缀违规 → 加载层校验失败 → 回退
		writeFile(dir, "db/schema.sql", "CREATE TABLE evil_x (id INTEGER);\n");
		const fallback = cache.getPacks();
		assert.equal(fallback.packs[0]!.entries[0]!.name, "甲", "回退快照可用");
		assert.match(fallback.warnings[0]!, /命名空间前缀违规/);
	} finally {
		cleanupTempDir(root);
	}
});

test("PackCache：多目录共同跟踪；单包变化触发整体重载", () => {
	const root = makeTempDir();
	try {
		const a = createPack(root, { name: "a", entries: [{ type: "characters", id: "x", yaml: characterEntry("A甲") }] });
		const b = createPack(root, { name: "b", entries: [{ type: "characters", id: "y", yaml: characterEntry("B乙") }] });
		const cache = new PackCache([a, join(root, "b")]);
		assert.equal(cache.getPacks().packs.length, 2);

		writeFile(a, "collection/characters/x.yaml", characterEntry("A改"));
		const res = cache.getPacks();
		assert.equal(res.packs.find((p) => p.name === "a")!.entries[0]!.name, "A改");
		assert.equal(res.packs.find((p) => p.name === "b")!.entries[0]!.name, "B乙");
	} finally {
		cleanupTempDir(root);
	}
});

test("PackCache：新增文件（新条目）也被 mtime 变化检测到", () => {
	const root = makeTempDir();
	try {
		const dir = createPack(root, {
			name: "p",
			entries: [{ type: "characters", id: "a", yaml: characterEntry("甲") }],
		});
		const cache = new PackCache([dir]);
		assert.equal(cache.getPacks().packs[0]!.entries.length, 1);

		writeFile(dir, "collection/locations/castle.yaml", entryYaml({ type: "location", name: "古堡", overview: "o", features: [] }));
		assert.equal(cache.getPacks().packs[0]!.entries.length, 2);
	} finally {
		cleanupTempDir(root);
	}
});
