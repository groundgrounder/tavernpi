// subagent 运行时纯逻辑单测（真实 LLM 集成在 P3，不在此测）：
// usage 映射（mapSubagentUsage）与 SubagentOutputError 类型行为。

import assert from "node:assert/strict";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import { mapSubagentUsage, SubagentOutputError } from "../src/subagent/runtime.ts";

const fakeStats: SessionStats = {
	sessionFile: undefined,
	sessionId: "inmemory",
	userMessages: 1,
	assistantMessages: 1,
	toolCalls: 1,
	toolResults: 1,
	totalMessages: 2,
	tokens: { input: 10, output: 20, cacheRead: 5, cacheWrite: 3, total: 38 },
	cost: 0.5,
};

test("mapSubagentUsage：tokens 与 cost 一一映射到 SubagentUsage", () => {
	assert.deepEqual(mapSubagentUsage(fakeStats), {
		input: 10,
		output: 20,
		cacheRead: 5,
		cacheWrite: 3,
		totalTokens: 38,
		costTotal: 0.5,
	});
});

test("mapSubagentUsage：cost 缺失时 costTotal 缺省 0", () => {
	const stats = { ...fakeStats, cost: 0 as number };
	assert.equal(mapSubagentUsage(stats).costTotal, 0);
});

test("SubagentOutputError：是 Error 且 name 正确（结构化输出缺失的异常面）", () => {
	const err = new SubagentOutputError("模型未调用输出工具");
	assert.ok(err instanceof Error);
	assert.equal(err.name, "SubagentOutputError");
	assert.match(err.message, /未调用输出工具/);
});
