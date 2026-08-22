// renderNarratorPrompt 单测（§4.1 检索式注入接线；确定性，无需模型/网络）：
// packs 缺省空注入 / 命中注入（正文 + refs 摘要行 + injected 标识）/ 未知 pin 警告三通道 /
// 预算整条裁减 / 上一轮 turn_log narrativeText 参与扫描。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
	characterEntry,
	cleanupTempDir,
	createPack,
	locationEntry,
	makeTempDir,
} from "./fixtures/pack-fixtures.ts";
import { openStoryDb, type StoryDb } from "../src/db/story-db.ts";
import { PackCache } from "../src/pack/cache.ts";
import {
	renderNarratorPrompt,
	type NarratorPromptDeps,
} from "../src/pipeline/runtime.ts";
import type { PipelineEvent, PipelineEventLog } from "../src/pipeline/events.ts";

const TEMPLATE = [
	"DB={{db_summary}}",
	"INJ={{collection_injection}}",
	"REH={{npc_rehearsals}}",
	"SC={{scene_card}}",
	"OV={{oversee_note}}",
	"REV={{revision_request}}",
].join("\n");

interface Captured {
	warnings: string[];
	events: PipelineEvent[];
}

function makeDeps(
	storyDb: StoryDb,
	overrides: Partial<NarratorPromptDeps> & { captured?: Captured } = {},
): NarratorPromptDeps {
	const { captured, ...rest } = overrides;
	return {
		template: TEMPLATE,
		storyDb: () => storyDb,
		currentInput: () => "环顾四周",
		currentTurnSeq: () => 1,
		pendingRehearsals: () => undefined,
		pendingSceneCard: () => undefined,
		pendingOverseeNote: () => undefined,
		pendingRevision: () => undefined,
		onWarning: (m) => captured?.warnings.push(m),
		eventLog: captured
			? ({ record: (e: PipelineEvent) => captured.events.push(e) } as unknown as PipelineEventLog)
			: undefined,
		...rest,
	};
}

function shoulingPack(root: string): string {
	return createPack(root, {
		name: "shouling",
		entries: [
			{
				type: "characters",
				id: "shen-qiu",
				yaml: characterEntry("沈秋", {
					keys: ["沈秋", "守陵人"],
					position: "system",
					refs: ["location:royal-tomb"],
				}),
			},
			{
				type: "locations",
				id: "royal-tomb",
				yaml: locationEntry("王陵", { always_on: true, overview: "帝王长眠之地" }),
			},
			{
				type: "locations",
				id: "tomb-passage",
				yaml: locationEntry("墓道", { keys: ["墓道"], position: "recent" }),
			},
		],
	});
}

test("注入：packs 缺省 → 占位符渲染「（无世界包注入）」", () => {
	const root = makeTempDir();
	const db = openStoryDb(join(root, "story.db"));
	try {
		const { rendered, collectionInjected, collectionWarnings } = renderNarratorPrompt(makeDeps(db));
		assert.ok(rendered.includes("INJ=（无世界包注入）"));
		assert.deepEqual(collectionInjected, []);
		assert.deepEqual(collectionWarnings, []);
	} finally {
		db.close();
		cleanupTempDir(root);
	}
});

test("注入：keys 触发 + always_on 常驻 + refs 摘要行 + injected 标识", () => {
	const root = makeTempDir();
	const db = openStoryDb(join(root, "story.db"));
	try {
		const packDir = shoulingPack(root);
		const captured: Captured = { warnings: [], events: [] };
		const { rendered, collectionInjected, collectionWarnings } = renderNarratorPrompt(
			makeDeps(db, {
				packs: { cache: new PackCache([packDir]) },
				currentInput: () => "我走向墓道",
				captured,
			}),
		);
		// always_on 常驻（王陵）+ keys 触发（墓道）注入；沈秋未命中不注入
		assert.ok(rendered.includes("王陵"), "常驻条目正文在系统提示");
		assert.ok(rendered.includes("帝王长眠之地"), "常驻条目 overview 在系统提示");
		assert.ok(rendered.includes("墓道"), "触发条目在系统提示");
		assert.ok(!rendered.includes("身份"), "未命中条目（沈秋）不注入");
		assert.ok(collectionInjected.includes("shouling:location:royal-tomb"));
		assert.ok(collectionInjected.includes("shouling:location:tomb-passage"));
		assert.deepEqual(collectionWarnings, []);
	} finally {
		db.close();
		cleanupTempDir(root);
	}
});

test("注入：pinned 命中未触发条目 + refs 摘要行展开（王陵名称出现）", () => {
	const root = makeTempDir();
	const db = openStoryDb(join(root, "story.db"));
	try {
		const packDir = shoulingPack(root);
		const { rendered, collectionInjected } = renderNarratorPrompt(
			makeDeps(db, {
				packs: { cache: new PackCache([packDir]), pinned: () => ["shouling:character:shen-qiu"] },
			}),
		);
		assert.ok(collectionInjected.includes("shouling:character:shen-qiu"));
		assert.ok(rendered.includes("沈秋"), "钉住条目注入");
		// refs 一级摘要行：被引条目（王陵）未命中也展开摘要
		assert.ok(rendered.includes("王陵"), "refs 摘要行含被引条目名称");
	} finally {
		db.close();
		cleanupTempDir(root);
	}
});

test("注入：未知 pin → warning 三通道（返回值 + onWarning + 事件流 role=pack）", () => {
	const root = makeTempDir();
	const db = openStoryDb(join(root, "story.db"));
	try {
		const packDir = shoulingPack(root);
		const captured: Captured = { warnings: [], events: [] };
		const { collectionWarnings } = renderNarratorPrompt(
			makeDeps(db, {
				packs: { cache: new PackCache([packDir]), pinned: () => ["shouling:character:nobody"] },
				captured,
			}),
		);
		assert.ok(collectionWarnings.length > 0, "未知 pin 产生 warning");
		assert.ok(captured.warnings.some((w) => w.includes("[卡包]")), "onWarning 收到卡包警告");
		assert.ok(
			captured.events.some((e) => e.role === "pack"),
			"事件流收到 role=pack 记录",
		);
	} finally {
		db.close();
		cleanupTempDir(root);
	}
});

test("注入：预算极小 → 整条裁减 + warning", () => {
	const root = makeTempDir();
	const db = openStoryDb(join(root, "story.db"));
	try {
		const packDir = shoulingPack(root);
		const captured: Captured = { warnings: [], events: [] };
		const { collectionWarnings } = renderNarratorPrompt(
			makeDeps(db, {
				packs: { cache: new PackCache([packDir]), budgetTokens: 1 },
				currentInput: () => "我走向墓道",
				captured,
			}),
		);
		assert.ok(collectionWarnings.length > 0, "预算裁减产生 warning");
	} finally {
		db.close();
		cleanupTempDir(root);
	}
});

test("注入：keys 命中上一轮 turn_log narrativeText（recentNarrative 扫描）", () => {
	const root = makeTempDir();
	const db = openStoryDb(join(root, "story.db"));
	try {
		// 上一轮叙事含「守陵人」→ 本轮 input 不含关键词也触发沈秋
		db.writer.recordTurnLog({
			turnSeq: 1,
			sessionEntryId: "e1",
			userInput: "前进",
			narrativeText: "守陵人的灯火在甬道尽头摇曳。",
		});
		const packDir = shoulingPack(root);
		const { collectionInjected } = renderNarratorPrompt(
			makeDeps(db, {
				packs: { cache: new PackCache([packDir]) },
				currentInput: () => "我继续走",
				currentTurnSeq: () => 2,
			}),
		);
		assert.ok(
			collectionInjected.includes("shouling:character:shen-qiu"),
			"上一轮叙事文本参与 keys 扫描",
		);
	} finally {
		db.close();
		cleanupTempDir(root);
	}
});
