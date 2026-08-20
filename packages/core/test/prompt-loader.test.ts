// 提示词分层加载器单测：四层优先级、空/读失败回退、role 白名单、占位符渲染。

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import {
	builtinPromptsDir,
	defaultGlobalPromptsDir,
	loadPrompt,
	renderPlaceholders,
} from "../src/prompts/loader.ts";

/** 在 <root>/prompts/ 下写 <role>.md（层目录语义：pack/story 是根目录）。 */
function writeLayerPrompt(root: string, role: string, content: string): void {
	const promptsDir = join(root, "prompts");
	mkdirSync(promptsDir, { recursive: true });
	writeFileSync(join(promptsDir, `${role}.md`), content);
}

test("builtin 层：真实 packages/core/prompts/narrator.md 存在且可直接加载", () => {
	const result = loadPrompt("narrator");
	assert.equal(result.layer, "builtin");
	assert.equal(result.path, join(builtinPromptsDir(), "narrator.md"));
	assert.ok(result.content.length > 0, "narrator.md 内容非空");
	assert.deepEqual(result.warnings, []);
});

test("各层单独命中：global/pack/story 均以自身内容覆盖低层", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "全局内容");
		assert.equal(loadPrompt("narrator", { globalDir }).layer, "global");
		assert.equal(loadPrompt("narrator", { globalDir }).content, "全局内容");

		writeLayerPrompt(packDir, "narrator", "卡包内容");
		assert.equal(loadPrompt("narrator", { globalDir, packDir }).layer, "pack");
		assert.equal(loadPrompt("narrator", { globalDir, packDir }).content, "卡包内容");

		writeLayerPrompt(storyDir, "narrator", "故事内容");
		assert.equal(loadPrompt("narrator", { globalDir, packDir, storyDir }).layer, "story");
		assert.equal(loadPrompt("narrator", { globalDir, packDir, storyDir }).content, "故事内容");
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("四层同时存在：story 最高层生效，warnings 为空", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packDir, "narrator", "P");
		writeLayerPrompt(storyDir, "narrator", "S");
		const result = loadPrompt("narrator", { globalDir, packDir, storyDir });
		assert.equal(result.layer, "story");
		assert.equal(result.content, "S");
		assert.deepEqual(result.warnings, []);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("高层文件缺失：静默回退到下一存在层（无 warning）", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packDir, "narrator", "P");
		// story 层未提供文件 → 回退 pack
		const result = loadPrompt("narrator", { globalDir, packDir, storyDir });
		assert.equal(result.layer, "pack");
		assert.equal(result.content, "P");
		assert.deepEqual(result.warnings, []);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("高层文件为空（含纯空白）：warning 并回退到下一层", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	const storyDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		writeLayerPrompt(packDir, "narrator", "P");
		writeLayerPrompt(storyDir, "narrator", "   \n\t  "); // 纯空白 = 空
		const result = loadPrompt("narrator", { globalDir, packDir, storyDir });
		assert.equal(result.layer, "pack");
		assert.equal(result.content, "P");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /story 层提示词为空/);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
		cleanupTempDir(storyDir);
	}
});

test("高层文件读取失败（非 ENOENT）：warning 并回退到下一层", () => {
	const globalDir = makeTempDir();
	const packDir = makeTempDir();
	try {
		mkdirSync(globalDir, { recursive: true });
		writeFileSync(join(globalDir, "narrator.md"), "G");
		// pack 层的 narrator.md 用一个目录占位 → readFileSync 抛 EISDIR（非 ENOENT）
		mkdirSync(join(packDir, "prompts", "narrator.md"), { recursive: true });
		const result = loadPrompt("narrator", { globalDir, packDir });
		assert.equal(result.layer, "global");
		assert.equal(result.content, "G");
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0]!, /pack 层提示词读取失败/);
	} finally {
		cleanupTempDir(globalDir);
		cleanupTempDir(packDir);
	}
});

test("role 白名单校验：非法字符拒绝（防路径穿越），合法标识符放行", () => {
	for (const bad of ["../evil", "a/b", "narrator-x", "Narrator", "1narrator", "", "a b", ".", ".."]) {
		assert.throws(() => loadPrompt(bad), /非法提示词角色名/, `role ${JSON.stringify(bad)} 应被拒绝`);
	}
	// 合法：小写字母开头 + 数字/下划线 → 过校验；但内置层缺失该角色 → 未命中任何层抛错
	assert.equal(loadPrompt("narrator").role, "narrator");
	assert.throws(() => loadPrompt("data_reader_2"), /未命中任何层/);
});

test("renderPlaceholders：已知替换 / 未知原样保留并去重 / 两侧空白", () => {
	// 已知替换
	const known = renderPlaceholders("你好 {{name}}，今天是 {{date}}。", { name: "艾琳", date: "仲夏" });
	assert.equal(known.text, "你好 艾琳，今天是 仲夏。");
	assert.deepEqual(known.unknownPlaceholders, []);

	// 两侧空白允许
	assert.equal(renderPlaceholders("{{  name  }}", { name: "x" }).text, "x");

	// 重复出现全部替换
	assert.equal(renderPlaceholders("{{a}}-{{a}}", { a: "x" }).text, "x-x");

	// 未知：原样保留（含原始空白），去重保首现顺序
	const unknown = renderPlaceholders("{{ a }} 与 {{b}} 与 {{a}}", { c: "忽略" });
	assert.equal(unknown.text, "{{ a }} 与 {{b}} 与 {{a}}");
	assert.deepEqual(unknown.unknownPlaceholders, ["a", "b"]);

	// 已知值为空字符串也替换
	assert.equal(renderPlaceholders("[{{a}}]", { a: "" }).text, "[]");

	// 混合：已知替换、未知保留
	const mixed = renderPlaceholders("{{a}} 与 {{c}}", { a: "1" });
	assert.equal(mixed.text, "1 与 {{c}}");
	assert.deepEqual(mixed.unknownPlaceholders, ["c"]);
});

test("defaultGlobalPromptsDir 路径形态：~/.tavernpi/prompts", () => {
	assert.equal(defaultGlobalPromptsDir(), join(homedir(), ".tavernpi", "prompts"));
});
