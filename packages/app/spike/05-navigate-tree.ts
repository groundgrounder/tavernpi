// M0 spike #5：session.navigateTree + session_before_tree / session_tree 钩子。
//
// 目的（技术路线 §4 spike 清单第 5 项 / §3.1 快照恢复挂载点 / §3.2 第 6 行）：
//   a) 落盘 session（临时目录）制造分支：主线若干轮 → 导航回旧节点后 prompt 出分支 B；
//   b) 实证 session_before_tree / session_tree 钩子确实触发（顺序 + payload）；
//   c) 实证 navigateTree 语义：isStreaming 时抛错（先 await 完所有 prompt）；
//      目标是 user 消息时 newLeaf=parentId；目标是 assistant 消息时 newLeaf=目标本身；
//   d) 跳转后 prompt：后续生成基于目标节点上下文（分支 B 独有暗号，跳回主线后不应知道）；
//   e) 清理临时目录。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	createSyntheticSourceInfo,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type Extension,
	type LoadExtensionsResult,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_SETTINGS = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "high",
} as const;

// ---------------------------------------------------------------------------
// 钩子记录
// ---------------------------------------------------------------------------
interface HookLog {
	seq: number;
	event: string;
	detail: Record<string, unknown>;
}

const hookLogs: HookLog[] = [];
let hookSeq = 0;

type HookHandler = (event: unknown, ctx: unknown) => unknown;

/** 构造一个只带事件处理器的内联 Extension。 */
function makeHookExtension(handlers: Record<string, HookHandler>): Extension {
	const handlersMap = new Map<string, HookHandler[]>();
	for (const [name, fn] of Object.entries(handlers)) {
		handlersMap.set(name, [fn]);
	}
	const extension = {
		path: "<spike5-hooks>",
		resolvedPath: "<spike5-hooks>",
		sourceInfo: createSyntheticSourceInfo("<spike5-hooks>", { source: "temporary" }),
		handlers: handlersMap,
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	return extension as unknown as Extension;
}

class HookResourceLoader implements ResourceLoader {
	private readonly extensionsResult: LoadExtensionsResult;

	constructor() {
		const extension = makeHookExtension({
			session_before_tree: (event) => {
				const e = event as {
					preparation: {
						targetId: string;
						oldLeafId: string | null;
						commonAncestorId: string | null;
						entriesToSummarize: unknown[];
						userWantsSummary: boolean;
					};
				};
				hookLogs.push({
					seq: ++hookSeq,
					event: "session_before_tree",
					detail: {
						targetId: e.preparation.targetId,
						oldLeafId: e.preparation.oldLeafId,
						commonAncestorId: e.preparation.commonAncestorId,
						entriesToSummarizeCount: e.preparation.entriesToSummarize.length,
						userWantsSummary: e.preparation.userWantsSummary,
					},
				});
				// 不返回任何值：不取消、不提供摘要。
			},
			session_tree: (event) => {
				const e = event as {
					newLeafId: string | null;
					oldLeafId: string | null;
					summaryEntry?: unknown;
					fromExtension?: boolean;
				};
				hookLogs.push({
					seq: ++hookSeq,
					event: "session_tree",
					detail: {
						newLeafId: e.newLeafId,
						oldLeafId: e.oldLeafId,
						hasSummaryEntry: e.summaryEntry !== undefined,
						fromExtension: e.fromExtension,
					},
				});
			},
		});
		this.extensionsResult = {
			extensions: [extension],
			errors: [],
			runtime: createExtensionRuntime(),
		};
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}
	getSkills(): { skills: never[]; diagnostics: never[] } {
		return { skills: [], diagnostics: [] };
	}
	getPrompts(): { prompts: never[]; diagnostics: never[] } {
		return { prompts: [], diagnostics: [] };
	}
	getThemes(): { themes: never[]; diagnostics: never[] } {
		return { themes: [], diagnostics: [] };
	}
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: [] };
	}
	getSystemPrompt(): string | undefined {
		return "你是一个用于会话树导航测试的助手。回答尽量简短（一两句话）。不要调用任何工具。";
	}
	getSystemPromptSource(): { path: string } | undefined {
		return undefined;
	}
	getAppendSystemPrompt(): string[] {
		return [];
	}
	getAppendSystemPromptSources(): Array<{ path: string }> {
		return [];
	}
	extendResources(_paths: unknown): void {}
	async reload(_options?: unknown): Promise<void> {}
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function extractLastAssistantReply(messages: ReadonlyArray<{ role: string; content?: unknown }>): string | undefined {
	for (const msg of [...messages].reverse()) {
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		const text = (msg.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		if (text.trim() !== "") return text;
	}
	return undefined;
}

function entryText(entry: { type: string; message?: { role: string; content?: unknown } }): string {
	const msg = entry.message;
	if (!msg || !Array.isArray(msg.content)) return "";
	return (msg.content as Array<{ type: string; text?: string }>)
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

function assert(condition: boolean, label: string): void {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) throw new Error(`断言失败：${label}`);
}

async function main(): Promise<void> {
	const tmpDir = mkdtempSync(join(tmpdir(), "tavernpi-spike5-"));
	const cwd = tmpDir;
	const sessionDir = join(tmpDir, "sessions");

	try {
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ ...DEFAULT_SETTINGS }),
			resourceLoader: new HookResourceLoader(),
			modelRuntime: await ModelRuntime.create({ modelsPath: null }),
			noTools: "all",
		});

		console.log(`> session file: ${session.sessionManager.getSessionFile()}`);

		// 主线三轮。
		await session.prompt("主线第一轮。请回复：收到1。");
		await session.prompt("主线第二轮。请回复：收到2。");
		await session.prompt("主线第三轮。记住：主线暗号是红色。请回复：记住了红色。");

		const userEntries = session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user");
		const asstEntries = session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "assistant");
		const u1 = userEntries[0];
		const u2 = userEntries[1];
		const a1 = asstEntries[0];
		const a3 = asstEntries[2];
		if (!u1 || !u2 || !a1 || !a3) throw new Error("未收集到主线消息条目");
		console.log(`> 主线条目: u1=${u1.id} a1=${a1.id} u2=${u2.id} a3=${a3.id}`);
		console.log(`> 叶子: ${session.sessionManager.getLeafId()}（期望=${a3.id}）`);

		// ---- 制造分支 B：导航到主线第二轮的 user 消息 u2。 ----
		assert(!session.isStreaming, "prompt 全部 await 完毕后 isStreaming=false");
		const nav1 = await session.navigateTree(u2.id);
		const leafAfterNav1 = session.sessionManager.getLeafId();
		console.log(`> navigateTree(u2=user) → newLeaf=${leafAfterNav1}, u2.parentId=${u2.parentId}, editorText=${JSON.stringify(nav1.editorText)}`);
		// 语义②：目标是 user 消息 → newLeaf = 目标 parentId（= a1）。
		assert(leafAfterNav1 === u2.parentId, "navigateTree(user) 后 newLeaf === u2.parentId（a1）");
		assert(leafAfterNav1 === a1.id, "navigateTree(user) 后 newLeaf === a1.id");
		assert(nav1.editorText !== undefined && nav1.editorText.includes("主线第二轮"), "editorText 为 u2 的原文");

		// 在分支 B 上 prompt，声明分支暗号。
		await session.prompt("分支B开始。记住：分支暗号是紫色。请回复：记住了紫色。");
		const branchLeaf = session.sessionManager.getLeafId();
		console.log(`> 分支 B 叶子: ${branchLeaf}（应 ≠ 主线 a3=${a3.id}）`);
		assert(branchLeaf !== a3.id, "分支 B 叶子与主线叶子不同（同一文件内真分支）");

		// 分支 B 上下文自检：应知道紫色。
		await session.prompt("我们的暗号是什么？只回答暗号本身。");
		const replyOnBranch = extractLastAssistantReply(session.state.messages) ?? "";
		console.log(`> 分支 B 上问暗号 → ${JSON.stringify(replyOnBranch)}`);
		assert(replyOnBranch.includes("紫色"), "分支 B 上下文包含分支暗号（紫色）");

		// ---- 导航回主线 a3（assistant 目标 → newLeaf = 目标本身）。 ----
		assert(!session.isStreaming, "再次确认 isStreaming=false");
		const nav2 = await session.navigateTree(a3.id);
		const leafAfterNav2 = session.sessionManager.getLeafId();
		console.log(`> navigateTree(a3=assistant) → newLeaf=${leafAfterNav2}, editorText=${JSON.stringify(nav2.editorText)}`);
		assert(leafAfterNav2 === a3.id, "navigateTree(assistant) 后 newLeaf === a3.id（目标本身）");
		assert(nav2.editorText === undefined, "非 user 目标不返回 editorText");

		// 跳转后再 prompt 一轮：应基于主线上下文——知道红色，不知道紫色。
		await session.prompt("现在回答：1) 主线暗号是什么？2) 分支B里说过的暗号是什么？如果当前对话里没有提到过分支暗号，第2个问题只回答「不知道」。");
		const replyBack = extractLastAssistantReply(session.state.messages) ?? "";
		console.log("--- 跳回主线后的回复 ---");
		console.log(replyBack);
		assert(replyBack.includes("红色"), "跳回主线后仍知道主线暗号（红色）");
		assert(!replyBack.includes("紫色"), "跳回主线后不知道分支 B 暗号（紫色）");

		// 确定性佐证：当前 buildSessionContext 的转录里不含分支 B 文本。
		const ctxTexts = session.sessionManager
			.buildSessionContext()
			.messages.map((m) => entryText({ type: "message", message: m as { role: string; content?: unknown } }))
			.join("\n");
		assert(!ctxTexts.includes("紫色"), "buildSessionContext 上下文不含分支 B 文本（紫色）");
		assert(ctxTexts.includes("红色"), "buildSessionContext 上下文含主线暗号（红色）");

		// ---- 钩子触发顺序与 payload ----
		console.log("--- 钩子日志（按触发顺序） ---");
		for (const log of hookLogs) {
			console.log(`#${log.seq} ${log.event} ${JSON.stringify(log.detail)}`);
		}
		assert(hookLogs.length === 4, "两次 navigateTree 各触发 session_before_tree + session_tree，共 4 条");
		assert(hookLogs[0]?.event === "session_before_tree" && hookLogs[1]?.event === "session_tree", "第一次导航：before_tree → tree");
		assert(hookLogs[2]?.event === "session_before_tree" && hookLogs[3]?.event === "session_tree", "第二次导航：before_tree → tree");
		const t1 = hookLogs[1]?.detail as { newLeafId?: unknown };
		const t2 = hookLogs[3]?.detail as { newLeafId?: unknown };
		assert(t1.newLeafId === u2.parentId, "session_tree#1 payload newLeafId === u2.parentId");
		assert(t2.newLeafId === a3.id, "session_tree#2 payload newLeafId === a3.id");

		console.log("=== spike #5 全部断言通过 ===");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
		console.log(`> 已清理临时目录: ${tmpDir}`);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
