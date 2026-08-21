// runtime 纯函数单测（§6.3 打回重写 userEntryId 修正）：findUserEntryOnBranch。
// 背景：打回重写后原 u_N 与新 u_N' 同 parentId（同挂 a_{N-1}），find-first 会误中旧稿；
// 从最终 leaf 沿 parentId 上溯找第一个 user entry 才能命中新稿所在分支。

import assert from "node:assert/strict";
import { test } from "node:test";
import { findUserEntryOnBranch } from "../src/pipeline/runtime.ts";

interface EntryLike {
	id: string;
	parentId: string | null;
	type?: string;
	message?: { role?: string };
}

function user(id: string, parentId: string | null): EntryLike {
	return { type: "message", id, parentId, message: { role: "user" } };
}

function assistant(id: string, parentId: string | null): EntryLike {
	return { type: "message", id, parentId, message: { role: "assistant" } };
}

function thinking(id: string, parentId: string | null): EntryLike {
	return { type: "thinking_level_change", id, parentId };
}

test("findUserEntryOnBranch：简单链从 leaf 上溯命中最近 user entry", () => {
	const entries = [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2")];
	assert.equal(findUserEntryOnBranch(entries, "a2"), "u2");
	assert.equal(findUserEntryOnBranch(entries, "a1"), "u1");
});

test("findUserEntryOnBranch：同 parentId 多稿（旧稿 u2 + 新稿 u2'）→ 从最终 leaf 命中新分支 u2'", () => {
	// 打回重写后树：a1 → u2 → a2（旧稿，被弃）；a1 → u2' → a2'（新稿，leaf）
	const entries = [
		user("u1", null),
		assistant("a1", "u1"),
		user("u2", "a1"),
		assistant("a2", "u2"),
		user("u2p", "a1"),
		assistant("a2p", "u2p"),
	];
	assert.equal(findUserEntryOnBranch(entries, "a2p"), "u2p", "最终 leaf 上溯命中新稿 user entry，不误中旧稿 u2");
});

test("findUserEntryOnBranch：非 message 条目（thinking_level_change）不阻断上溯", () => {
	const entries = [user("u1", null), assistant("a1", "u1"), thinking("t1", "a1"), user("u2", "t1"), assistant("a2", "u2")];
	assert.equal(findUserEntryOnBranch(entries, "a2"), "u2");
});

test("findUserEntryOnBranch：leaf 本身是 user entry → 返回自身", () => {
	const entries = [user("u1", null), assistant("a1", "u1"), user("u2", "a1")];
	assert.equal(findUserEntryOnBranch(entries, "u2"), "u2");
});

test("findUserEntryOnBranch：找不到（leaf 不存在 / 链上无 user）→ null", () => {
	const entries = [user("u1", null), assistant("a1", "u1")];
	assert.equal(findUserEntryOnBranch(entries, "不存在"), null);
	// 祖先链全是非 user message（构造畸形）→ 无 user → null
	const weird = [assistant("a0", null), assistant("a1", "a0")];
	assert.equal(findUserEntryOnBranch(weird, "a1"), null);
});
