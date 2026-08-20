// pipeline 事件流单测：JSONL 落盘、纯内存模式、listener 通知/退订/异常隔离、写失败容错。

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";
import { createPipelineEventLog, type PipelineEvent } from "../src/pipeline/events.ts";

const eventFixture: PipelineEvent = {
	ts: "2026-08-20T00:00:00.000Z",
	turnSeq: 1,
	role: "narrator",
	ok: true,
	durationMs: 123,
	attempt: 1,
	inputChars: 50,
	outputChars: 200,
	usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 38, costTotal: 0.5 },
};

test("record 写 JSONL：每行一个事件，字段往返一致（含可选字段）", () => {
	const dir = makeTempDir();
	try {
		const filePath = join(dir, "events", "pipeline.jsonl");
		const log = createPipelineEventLog(filePath);
		log.record(eventFixture);
		log.record({ ...eventFixture, turnSeq: 2, role: "data", ok: false, error: "boom" });

		const lines = readFileSync(filePath, "utf-8").trimEnd().split("\n");
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]!) as PipelineEvent;
		assert.deepEqual(first, eventFixture);
		const second = JSON.parse(lines[1]!) as PipelineEvent;
		assert.equal(second.turnSeq, 2);
		assert.equal(second.ok, false);
		assert.equal(second.error, "boom");
		assert.equal(second.attempt, 1, "可选字段透传");
		assert.equal(log.filePath, filePath);
	} finally {
		cleanupTempDir(dir);
	}
});

test("无 filePath：纯内存模式，record 不落盘也不抛错", () => {
	const log = createPipelineEventLog();
	assert.equal(log.filePath, undefined);
	const notified: PipelineEvent[] = [];
	log.on((e) => notified.push(e));
	assert.doesNotThrow(() => log.record(eventFixture));
	assert.equal(notified.length, 1);
});

test("listener 通知与退订：on 返回退订函数", () => {
	const log = createPipelineEventLog();
	const received: string[] = [];
	const off = log.on((e) => received.push(e.role));
	log.record(eventFixture);
	assert.deepEqual(received, ["narrator"]);
	off();
	log.record({ ...eventFixture, role: "data" });
	assert.deepEqual(received, ["narrator"], "退订后不再通知");
});

test("listener 抛错不影响 record：其他 listener 照常、落盘照常", () => {
	const dir = makeTempDir();
	try {
		const filePath = join(dir, "events.jsonl");
		const log = createPipelineEventLog(filePath);
		const good: string[] = [];
		log.on(() => {
			throw new Error("listener 炸了");
		});
		log.on((e) => good.push(e.role));
		assert.doesNotThrow(() => log.record(eventFixture));
		assert.deepEqual(good, ["narrator"], "抛错的 listener 不连累其他 listener");
		assert.ok(readFileSync(filePath, "utf-8").includes(eventFixture.role), "落盘不受 listener 异常影响");
	} finally {
		cleanupTempDir(dir);
	}
});

test("写失败路径：目标位置非法（父级是普通文件）→ 不抛，仅首次 console.warn", () => {
	const dir = makeTempDir();
	const originalWarn = console.warn;
	let warnCount = 0;
	console.warn = () => {
		warnCount++;
	};
	try {
		// 用普通文件占住父路径：mkdirSync(dirname) 必然失败
		writeFileSync(join(dir, "blocker"), "占用");
		const filePath = join(dir, "blocker", "events.jsonl");
		const log = createPipelineEventLog(filePath);
		assert.doesNotThrow(() => log.record(eventFixture));
		assert.doesNotThrow(() => log.record({ ...eventFixture, turnSeq: 2 }));
		assert.equal(warnCount, 1, "写失败仅首次告警（去重）");
	} finally {
		console.warn = originalWarn;
		cleanupTempDir(dir);
	}
});
