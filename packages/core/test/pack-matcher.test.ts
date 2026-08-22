// 设定集匹配引擎单测（创作规划 §4.1 匹配语义 M5 定稿 / §8 决策行「检索式注入引擎」）：
// 子串大小写不敏感 / 三通道优先级（钉 > 常驻 > 触发）/ 命中数排序与同数字典序 /
// 预算整条裁减 / 单条超预算截断 / refs 摘要行（被引未命中也展开）/ 未知 pin warning /
// position 分流（systemText / recentText）。

import assert from "node:assert/strict";
import { test } from "node:test";
import { characterEntry, cleanupTempDir, createPack, entryYaml, locationEntry, makeTempDir } from "./fixtures/pack-fixtures.ts";
import { loadPacks } from "../src/pack/loader.ts";
import { buildCollectionInjection, estimateTokens } from "../src/pack/matcher.ts";
import type { WorldPack } from "../src/pack/types.ts";

/** 构造单包（name = "p"），返回加载后的 packs。 */
function loadSinglePack(entries: Array<{ type: string; id: string; yaml: string }>): WorldPack[] {
	const root = makeTempDir();
	try {
		const dir = createPack(root, { name: "p", entries });
		return loadPacks([dir]);
	} finally {
		cleanupTempDir(root);
	}
}

test("estimateTokens：ceil(len/2)", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("ab"), 1);
	assert.equal(estimateTokens("abc"), 2);
	assert.equal(estimateTokens("你好世界"), 2);
});

test("匹配：大小写不敏感子串，keys 任一命中即触发；recentNarrative 并入扫描文本", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "a", yaml: characterEntry("艾琳", { keys: ["Shen Qiu", "Tomb"] }) },
		{ type: "characters", id: "b", yaml: characterEntry("路人", { keys: ["无关"] }) },
	]);
	// input 大小写不敏感命中
	const res1 = buildCollectionInjection(packs, { input: "shen qiu 走进来", budgetTokens: 1000 });
	assert.deepEqual(res1.injected, ["p:character:a"]);
	// 触发词在 recentNarrative 中命中
	const res2 = buildCollectionInjection(packs, { input: "你醒了", recentNarrative: "the tomb was silent" });
	assert.deepEqual(res2.injected, ["p:character:a"]);
	// 中文 keys 直接命中
	const res3 = buildCollectionInjection(packs, { input: "那座 Tomb 很大" });
	assert.deepEqual(res3.injected, ["p:character:a"]);
});

test("三通道优先级：钉 > 常驻 > 触发，注入顺序与条目标识一致", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "c_triggered", yaml: characterEntry("丙", { keys: ["alpha", "bravo"], position: "system" }) },
		{ type: "characters", id: "b_always", yaml: characterEntry("乙", { always_on: true, position: "system" }) },
		{ type: "characters", id: "a_pinned", yaml: characterEntry("甲", { position: "system" }) },
	]);
	const res = buildCollectionInjection(packs, {
		input: "alpha bravo",
		pinned: ["p:character:a_pinned"],
		budgetTokens: 5000,
	});
	// 三通道全部命中
	assert.deepEqual(res.injected, ["p:character:a_pinned", "p:character:b_always", "p:character:c_triggered"]);
	// 渲染顺序：钉 > 常驻 > 触发
	const sys = res.systemText;
	const order = ["甲", "乙", "丙"].map((n) => sys.indexOf(`## ${n}`));
	assert.ok(order[0]! >= 0 && order[1]! > order[0]! && order[2]! > order[1]!, `顺序错误: ${sys}`);
});

test("常驻条目不依赖触发词；触发条目按命中数降序、同数按 包名:type:id 字典序", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "two", yaml: characterEntry("双命中", { keys: ["alpha", "bravo"], position: "system" }) },
		{ type: "characters", id: "one", yaml: characterEntry("单命中", { keys: ["alpha"], position: "system" }) },
		{ type: "characters", id: "zz", yaml: characterEntry("单命中同数", { keys: ["alpha"], position: "system" }) },
	]);
	const res = buildCollectionInjection(packs, { input: "alpha bravo", budgetTokens: 5000 });
	// two（2 命中）在前；one 与 zz 同 1 命中按字典序（p:character:one < p:character:zz）
	assert.deepEqual(res.injected, ["p:character:two", "p:character:one", "p:character:zz"]);
});

test("预算整条裁减：低优先级整条被裁 + warning（含条目标识），高优先级保留", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "pin", yaml: characterEntry("钉子", { position: "system" }) },
		{ type: "characters", id: "always", yaml: characterEntry("常驻", { always_on: true, position: "system" }) },
		{ type: "characters", id: "trig", yaml: characterEntry("触发者", { keys: ["keyword"], position: "system" }) },
	]);
	// 每条约 ~30 字 → ~15 tokens；预算 30 tokens ≈ 钉子+常驻，触发者被裁
	const res = buildCollectionInjection(packs, {
		input: "keyword",
		pinned: ["p:character:pin"],
		budgetTokens: 30,
	});
	assert.deepEqual(res.injected, ["p:character:pin", "p:character:always"]);
	assert.ok(res.warnings.some((w) => /整条裁减: p:character:trig/.test(w)), `warnings: ${JSON.stringify(res.warnings)}`);
	assert.ok(!res.systemText.includes("触发者"));
});

test("单条自身超预算：正文截断注入 + warning（条目标识在 injected 中）", () => {
	const packs = loadSinglePack([
		{
			type: "characters",
			id: "huge",
			yaml: entryYaml({
				type: "character",
				name: "巨量",
				position: "system",
				identity: "x".repeat(4000),
				personality: "y",
			}),
		},
	]);
	// 无 keys/常驻 → 须手动钉才成为候选
	const res = buildCollectionInjection(packs, { input: "", pinned: ["p:character:huge"], budgetTokens: 200 });
	assert.deepEqual(res.injected, ["p:character:huge"], "截断注入仍计入 injected");
	assert.ok(res.warnings.some((w) => /正文已截断: p:character:huge/.test(w)), `warnings: ${JSON.stringify(res.warnings)}`);
	// 截断后渲染远小于原始（4000 字 body），且符合预算量级
	assert.ok(res.systemText.length < 1000, `应已截断，实际长度 ${res.systemText.length}`);
});

test("refs 摘要行：命中条目展开一级摘要行（被引条目未命中也展开），渲染格式正确", () => {
	const packs = loadSinglePack([
		{
			type: "characters",
			id: "hero",
			yaml: characterEntry("主角", { keys: ["主角"], refs: ["location:castle", "character:companion"] }),
		},
		{ type: "locations", id: "castle", yaml: locationEntry("古堡", { overview: "巍峨的古堡" }) },
		{ type: "characters", id: "companion", yaml: characterEntry("伙伴") },
	]);
	const res = buildCollectionInjection(packs, { input: "主角出现", budgetTokens: 5000 });
	assert.deepEqual(res.injected, ["p:character:hero"]);
	const text = res.systemText;
	assert.match(text, /## 主角（character）/);
	assert.match(text, /【关联】/);
	assert.match(text, /- 古堡：概述：巍峨的古堡/);
	assert.match(text, /- 伙伴：身份：身份/);
});

test("position 分流：system 进 systemText，recent 进 recentText；缺省 position = system", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "sys", yaml: characterEntry("基调", { always_on: true, position: "system" }) },
		{ type: "characters", id: "rec", yaml: characterEntry("近叙", { always_on: true, position: "recent" }) },
		{ type: "characters", id: "def", yaml: characterEntry("默认", { always_on: true }) },
	]);
	const res = buildCollectionInjection(packs, { input: "", budgetTokens: 5000 });
	assert.ok(res.systemText.includes("## 基调"), "system 进 systemText");
	assert.ok(res.systemText.includes("## 默认"), "缺省 position 进 systemText");
	assert.ok(res.recentText.includes("## 近叙"), "recent 进 recentText");
	assert.ok(!res.recentText.includes("基调"));
});

test("未知 pin → warning 忽略；无其他命中时 injected 为空", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "a", yaml: characterEntry("甲", { keys: ["从不出现"] }) },
	]);
	const res = buildCollectionInjection(packs, {
		input: "无关内容",
		pinned: ["p:character:nonexistent", "other_pack:location:nowhere"],
		budgetTokens: 5000,
	});
	assert.deepEqual(res.injected, []);
	assert.equal(res.warnings.length, 2);
	assert.match(res.warnings[0]!, /未知手动钉: p:character:nonexistent/);
	assert.match(res.warnings[1]!, /未知手动钉: other_pack:location:nowhere/);
});

test("pinned 钉不触发也注入（空 keys 条目）", () => {
	const packs = loadSinglePack([
		{ type: "characters", id: "quiet", yaml: characterEntry("静默者", { position: "recent" }) },
	]);
	const res = buildCollectionInjection(packs, { input: "无关键词", pinned: ["p:character:quiet"] });
	assert.deepEqual(res.injected, ["p:character:quiet"]);
	assert.ok(res.recentText.includes("## 静默者"));
});
