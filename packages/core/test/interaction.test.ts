// 轮中交互通道（创作规划 §6.7）单测：broker 语义 + combat 判定规则。确定性无 LLM。

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
	InteractionBroker,
	InteractionTimeoutError,
	InteractionUnavailableError,
	InteractionValidationError,
	judgeCombat,
} from "../src/interaction/index.ts";

const confirmSchema = Type.Object({ confirmed: Type.Boolean() });
const choiceSchema = Type.Object({ option: Type.Integer() });

test("无 handler → InteractionUnavailableError（kind 可辨识，工具降级路径触发点）", async () => {
	const broker = new InteractionBroker();
	await assert.rejects(
		broker.request({ kind: "confirm", prompt: "p", responseSchema: confirmSchema }),
		(err: unknown) => err instanceof InteractionUnavailableError && err.kind === "confirm",
	);
});

test("注册 handler 后 request 往返：值透传", async () => {
	const broker = new InteractionBroker();
	broker.registerHandler(async (req) => ({ confirmed: req.prompt === "继续？" }));
	const result = await broker.request({ kind: "confirm", prompt: "继续？", responseSchema: confirmSchema });
	assert.deepEqual(result, { confirmed: true });
});

test("responseSchema 校验：不合 schema → InteractionValidationError（含细节）；合 schema → 通过", async () => {
	const broker = new InteractionBroker();
	// 非法响应：confirmed 应为 boolean（typebox Errors 报 must be boolean）
	broker.registerHandler(async () => ({ confirmed: "yes" }));
	await assert.rejects(
		broker.request({ kind: "confirm", prompt: "p", responseSchema: confirmSchema }),
		(err: unknown) =>
			err instanceof InteractionValidationError && err.kind === "confirm" && /must be boolean/.test(err.message),
	);
	// 重注册合法 handler → 通过
	broker.registerHandler(async () => ({ confirmed: false }));
	const ok = await broker.request({ kind: "confirm", prompt: "p", responseSchema: confirmSchema });
	assert.deepEqual(ok, { confirmed: false });
});

test("timeoutMs 超时（handler 挂起不返回）→ InteractionTimeoutError", async () => {
	const broker = new InteractionBroker();
	broker.registerHandler(async () => new Promise(() => {})); // 永不返回
	await assert.rejects(
		broker.request({ kind: "confirm", prompt: "p", responseSchema: confirmSchema, timeoutMs: 30 }),
		(err: unknown) => err instanceof InteractionTimeoutError && err.timeoutMs === 30,
	);
});

test("重复 registerHandler = 替换（UI 重建后新 handler 接管）", async () => {
	const broker = new InteractionBroker();
	broker.registerHandler(async () => ({ confirmed: true }));
	broker.registerHandler(async () => ({ confirmed: false }));
	const result = await broker.request({ kind: "confirm", prompt: "p", responseSchema: confirmSchema });
	assert.deepEqual(result, { confirmed: false });
});

test("choice 交互：响应为选中序号，经 schema 校验返回", async () => {
	const broker = new InteractionBroker();
	broker.registerHandler(async () => ({ option: 1 }));
	const result = await broker.request({
		kind: "choice",
		prompt: "选",
		payload: { options: ["稳扎稳打", "冒险突进", "伺机闪避"] },
		responseSchema: choiceSchema,
	});
	assert.deepEqual(result, { option: 1 });
});

// ---------------------------------------------------------------------------
// combat 判定规则（success/partial/failure 组合映射）
// ---------------------------------------------------------------------------

test("judgeCombat 判定矩阵：easy（target 5）", () => {
	// 稳扎稳打 4→partial；+全力 6→success；突进 5→success；闪避 3→failure；闪避+全力 5→success
	assert.equal(judgeCombat({ difficulty: "easy", choiceOption: 0, allIn: false }).outcome, "partial");
	assert.equal(judgeCombat({ difficulty: "easy", choiceOption: 0, allIn: true }).outcome, "success");
	assert.equal(judgeCombat({ difficulty: "easy", choiceOption: 1, allIn: false }).outcome, "success");
	assert.equal(judgeCombat({ difficulty: "easy", choiceOption: 2, allIn: false }).outcome, "failure");
	assert.equal(judgeCombat({ difficulty: "easy", choiceOption: 2, allIn: true }).outcome, "success");
});

test("judgeCombat 判定矩阵：normal（target 6）", () => {
	// 稳扎 4→failure；+全力 6→success；突进 5→partial；+全力 7→success；闪避 3→failure；+全力 5→partial
	assert.equal(judgeCombat({ difficulty: "normal", choiceOption: 0, allIn: false }).outcome, "failure");
	assert.equal(judgeCombat({ difficulty: "normal", choiceOption: 0, allIn: true }).outcome, "success");
	assert.equal(judgeCombat({ difficulty: "normal", choiceOption: 1, allIn: false }).outcome, "partial");
	assert.equal(judgeCombat({ difficulty: "normal", choiceOption: 1, allIn: true }).outcome, "success");
	assert.equal(judgeCombat({ difficulty: "normal", choiceOption: 2, allIn: false }).outcome, "failure");
	assert.equal(judgeCombat({ difficulty: "normal", choiceOption: 2, allIn: true }).outcome, "partial");
});

test("judgeCombat 判定矩阵：hard（target 7）", () => {
	// 稳扎 4→failure；+全力 6→partial；突进 5→failure；+全力 7→success；闪避 3→failure；+全力 5→failure
	assert.equal(judgeCombat({ difficulty: "hard", choiceOption: 0, allIn: false }).outcome, "failure");
	assert.equal(judgeCombat({ difficulty: "hard", choiceOption: 0, allIn: true }).outcome, "partial");
	assert.equal(judgeCombat({ difficulty: "hard", choiceOption: 1, allIn: false }).outcome, "failure");
	assert.equal(judgeCombat({ difficulty: "hard", choiceOption: 1, allIn: true }).outcome, "success");
	assert.equal(judgeCombat({ difficulty: "hard", choiceOption: 2, allIn: false }).outcome, "failure");
	assert.equal(judgeCombat({ difficulty: "hard", choiceOption: 2, allIn: true }).outcome, "failure");
});

test("judgeCombat 分数与提示：success 带 hint，score 正确", () => {
	const j = judgeCombat({ difficulty: "normal", choiceOption: 1, allIn: true });
	assert.equal(j.outcome, "success");
	assert.equal(j.score, 7);
	assert.ok(j.hint.length > 0);
});
