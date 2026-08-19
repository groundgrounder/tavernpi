// db 工具集单测：工具 execute 走强制写入 API（turnSeq 由注入提供），读写一致。

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { openStoryDb } from "../src/db/story-db.ts";
import { createDbTools } from "../src/db/tools.ts";
import { DEFAULT_STORY_CLOCK } from "../src/db/types.ts";

/** 测试用最小 ExtensionContext（工具 execute 不使用 ctx，仅满足签名）。 */
const ctx = {} as unknown as ExtensionContext;

function openTempStory(dir: string) {
	return openStoryDb(join(dir, "story.db"));
}

test("工具集构成：5 个工具、白名单可用", () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const tools = createDbTools(story);
		assert.deepEqual(
			tools.map((t) => t.name),
			["get_clock", "query_events", "get_npc", "write_event", "advance_clock"],
		);
		story.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("未注入 getCurrentTurnSeq 时写入工具 fail-loud，查询工具不受影响", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const tools = createDbTools(story); // 刻意不注入 provider

		const writeEvent = tools.find((t) => t.name === "write_event")!;
		const advanceClock = tools.find((t) => t.name === "advance_clock")!;
		await assert.rejects(
			writeEvent.execute("c1", { summary: "x" }, undefined, undefined, ctx),
			/当前轮次未注入/,
		);
		await assert.rejects(
			advanceClock.execute("c2", { to_time: "0000-01-02" }, undefined, undefined, ctx),
			/当前轮次未注入/,
		);

		// 查询工具可正常执行
		const getClock = tools.find((t) => t.name === "get_clock")!;
		const r = await getClock.execute("c3", {}, undefined, undefined, ctx);
		assert.equal((r.details as { clock: unknown }).clock !== undefined, true);

		// 写入工具抛错后 DB 未被污染
		assert.equal(story.reader.listEvents().length, 0);
		assert.equal(story.reader.listTimeLog().length, 0);
	} finally {
		cleanupTempDir(dir);
	}
});

test("write_event：注入的 getCurrentTurnSeq 决定落库 turn_seq（模型不接触），读回一致", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		let turn = 0;
		const tools = createDbTools(story, { getCurrentTurnSeq: () => turn });
		const writeEvent = tools.find((t) => t.name === "write_event")!;

		turn = 7;
		const result = await writeEvent.execute("call-1", { summary: "主角推门", detail: "木门吱呀" }, undefined, undefined, ctx);
		const row = result.details as { turn_seq: number; summary: string };
		assert.equal(row.turn_seq, 7);
		assert.equal(row.summary, "主角推门");
		assert.equal(result.content[0]?.type, "text");

		// 读回：query_events 按范围查
		const queryEvents = tools.find((t) => t.name === "query_events")!;
		const q = await queryEvents.execute("call-2", { from_turn: 7, to_turn: 7 }, undefined, undefined, ctx);
		const events = (q.details as { events: Array<{ turn_seq: number; summary: string }> }).events;
		assert.equal(events.length, 1);
		assert.equal(events[0]?.summary, "主角推门");

		// 模型不接触 turn_seq：write_event 的 schema 不含 turn_seq 参数
		const schema = writeEvent.parameters as { properties: Record<string, unknown> };
		assert.equal(schema.properties["turn_seq"], undefined);
	} finally {
		cleanupTempDir(dir);
	}
});

test("advance_clock：写 time_log + 更新 clock 单例；get_clock 读回", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		let turn = 0;
		const tools = createDbTools(story, { getCurrentTurnSeq: () => turn });

		turn = 3;
		const advanceClock = tools.find((t) => t.name === "advance_clock")!;
		const r = await advanceClock.execute(
			"call-1",
			{ to_time: "0000-01-03", span_note: "一夜" },
			undefined,
			undefined,
			ctx,
		);
		const tl = r.details as { turn_seq: number; from_time: string; to_time: string };
		assert.equal(tl.turn_seq, 3);
		assert.equal(tl.from_time, DEFAULT_STORY_CLOCK.current_time);
		assert.equal(tl.to_time, "0000-01-03");

		const getClock = tools.find((t) => t.name === "get_clock")!;
		const c = await getClock.execute("call-2", {}, undefined, undefined, ctx);
		const clock = (c.details as { clock: { current_time: string } }).clock;
		assert.equal(clock.current_time, "0000-01-03");

		// time_log 落库
		const tlRows = story.reader.listTimeLog();
		assert.equal(tlRows.length, 1);
		assert.equal(tlRows[0]?.turn_seq, 3);
	} finally {
		cleanupTempDir(dir);
	}
});

test("get_npc：写 NPC 数据后复合读回；不存在时返回空", async () => {
	const dir = makeTempDir();
	try {
		const story = openTempStory(dir);
		const npc = story.writer.insertNpc({ name: "艾琳" });
		story.writer.insertNpcTrait({ npcId: npc.id, trait: "勇敢", weight: 0.8, turnSeq: 1 });
		story.writer.insertNpcMemory({ npcId: npc.id, turnSeq: 1, kind: "event", content: "见过主角", salience: 1 });

		const tools = createDbTools(story);
		const getNpc = tools.find((t) => t.name === "get_npc")!;
		const r = await getNpc.execute("call-1", { npc_id: npc.id }, undefined, undefined, ctx);
		const composite = r.details as { npc: { name: string }; traits: unknown[]; memories: unknown[] };
		assert.equal(composite.npc.name, "艾琳");
		assert.equal(composite.traits.length, 1);
		assert.equal(composite.memories.length, 1);

		const missing = await getNpc.execute("call-2", { npc_id: 999 }, undefined, undefined, ctx);
		const missingText =
			missing.content[0]?.type === "text" ? missing.content[0].text : "";
		assert.ok(missingText.includes("不存在"));
	} finally {
		cleanupTempDir(dir);
	}
});
