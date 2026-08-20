// 模型配置（§6.6）单测：缺文件/坏 JSON/根节点与 models 形态/字段非法形态/正常解析。

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { defaultSettingsPath, loadSettings, type TavernSettings } from "../src/settings.ts";

function writeSettings(dir: string, content: string): string {
	const path = join(dir, "settings.json");
	writeFileSync(path, content);
	return path;
}

test("defaultSettingsPath 路径形态：~/.tavernpi/settings.json", () => {
	assert.equal(defaultSettingsPath(), join(homedir(), ".tavernpi", "settings.json"));
});

test("缺文件：空 settings 且无 warning", () => {
	const dir = makeTempDir();
	try {
		const { settings, warnings } = loadSettings(join(dir, "does-not-exist.json"));
		assert.deepEqual(settings, { models: {} });
		assert.deepEqual(warnings, []);
	} finally {
		cleanupTempDir(dir);
	}
});

test("坏 JSON：warning + 空 settings", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(dir, "{ 这不是 JSON");
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(settings, { models: {} });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /解析失败/);
	} finally {
		cleanupTempDir(dir);
	}
});

test("根节点非对象（数组/字符串/数字）：warning + 空 settings", () => {
	const dir = makeTempDir();
	try {
		for (const bad of ["[1,2]", '"x"', "42"]) {
			const path = writeSettings(dir, bad);
			const { settings, warnings } = loadSettings(path);
			assert.deepEqual(settings, { models: {} });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /根节点不是对象/);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("models 非对象：warning + 忽略 models 字段", () => {
	const dir = makeTempDir();
	try {
		for (const bad of ['{"models": 5}', '{"models": "x"}', '{"models": [1]}']) {
			const path = writeSettings(dir, bad);
			const { settings, warnings } = loadSettings(path);
			assert.deepEqual(settings, { models: {} });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0]!, /models 不是对象/);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("models 字段形态非法：warning + 忽略该字段，合法字段保留", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({
				models: {
					narrator: { provider: "anthropic", id: "claude-3-5-sonnet" }, // 合法
					data: 42, // 非对象
					story: { provider: "openai" }, // 缺 id
					npc: { provider: "", id: "x" }, // provider 空串
					stylize: null, // null
					unknown_role: { provider: "a", id: "b" }, // 未知键：静默忽略
				},
			}),
		);
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(settings, {
			models: { narrator: { provider: "anthropic", id: "claude-3-5-sonnet" } },
		} satisfies TavernSettings);
		assert.equal(warnings.length, 4, "data/story/npc/stylize 各一条，unknown_role 不告警");
		for (const w of warnings) {
			assert.match(w, /形态非法，已忽略/);
		}
	} finally {
		cleanupTempDir(dir);
	}
});

test("正常解析：五个角色全部合法，无 warning", () => {
	const dir = makeTempDir();
	try {
		const path = writeSettings(
			dir,
			JSON.stringify({
				models: {
					narrator: { provider: "anthropic", id: "m1" },
					data: { provider: "openai", id: "m2" },
					story: { provider: "anthropic", id: "m3" },
					npc: { provider: "google", id: "m4" },
					stylize: { provider: "openai", id: "m5" },
				},
			}),
		);
		const { settings, warnings } = loadSettings(path);
		assert.deepEqual(warnings, []);
		assert.equal(settings.models.narrator?.provider, "anthropic");
		assert.equal(settings.models.data?.id, "m2");
		assert.equal(settings.models.story?.provider, "anthropic");
		assert.equal(settings.models.npc?.provider, "google");
		assert.equal(settings.models.stylize?.id, "m5");
	} finally {
		cleanupTempDir(dir);
	}
});
