// M0 spike #7：compaction 定制——session_before_compact 返回自定义 CompactionResult
// 完全替换默认摘要。
//
// 目的（技术路线 §4 spike 清单第 7 项 / §3.1 第 3 行）：
//   a) 可编程触发 compaction：用 session.compact()（agent-session.ts:1790，manual 入口）。
//      prepareCompaction 在「会话太小」时返回 undefined（compaction.ts:765），因此用
//      SettingsManager.inMemory 注入极小的 keepRecentTokens 强制产生 cut point——
//      这是最短对话触发路径，替代「构造足够长的会话」。
//   b) 注册 session_before_compact 钩子，返回自定义 CompactionResult（summary 含独特
//      标记），完全替换默认摘要——默认摘要 LLM 调用被完全跳过（agent-session.ts:1833）。
//   c) 验证：压缩后 buildSessionContext 出现自定义标记、默认摘要未出现；打印证据。

import {
	createAgentSession,
	createExtensionRuntime,
	createSyntheticSourceInfo,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CompactionEntry,
	type Extension,
	type LoadExtensionsResult,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const MARKER = "TAVERNPI_CUSTOM_COMPACTION_MARKER_07_紫晶王座";

const SETTINGS = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "high",
	// 关键：极小 keepRecentTokens，使极短会话也能 prepareCompaction 成功（cut 在最末尾）。
	compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
} as const;

type HookHandler = (event: unknown, ctx: unknown) => unknown;

function makeHookExtension(handlers: Record<string, HookHandler>): Extension {
	const handlersMap = new Map<string, HookHandler[]>();
	for (const [name, fn] of Object.entries(handlers)) {
		handlersMap.set(name, [fn]);
	}
	const extension = {
		path: "<spike7-hooks>",
		resolvedPath: "<spike7-hooks>",
		sourceInfo: createSyntheticSourceInfo("<spike7-hooks>", { source: "temporary" }),
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
	hookEvents: Array<{ reason?: string; tokensBefore?: number; firstKeptEntryId?: string }> = [];

	constructor() {
		const extension = makeHookExtension({
			session_before_compact: (event) => {
				const e = event as {
					preparation: { firstKeptEntryId: string; tokensBefore: number };
					reason: string;
				};
				this.hookEvents.push({
					reason: e.reason,
					tokensBefore: e.preparation.tokensBefore,
					firstKeptEntryId: e.preparation.firstKeptEntryId,
				});
				// 完全替换默认摘要：返回自定义 CompactionResult。
				return {
					compaction: {
						summary: `自定义章节摘要：主角登上了${MARKER}，此前的对话已被这段手工摘要替换。`,
						firstKeptEntryId: e.preparation.firstKeptEntryId,
						tokensBefore: e.preparation.tokensBefore,
						estimatedTokensAfter: 1,
					},
				};
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
		return "你是一个用于压缩测试的助手。回答尽量简短（一句话）。不要调用任何工具。";
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

function messageText(msg: { role: string; content?: unknown; summary?: unknown }): string {
	if (typeof msg.summary === "string") return msg.summary;
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
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
	const loader = new HookResourceLoader();
	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ ...SETTINGS }),
		resourceLoader: loader,
		modelRuntime: await ModelRuntime.create({ modelsPath: null }),
		noTools: "all",
	});

	// 构造一段短会话（配合 keepRecentTokens=1 即可触发 compaction）。
	await session.prompt("第一句话：主角在码头登陆。请确认。");
	await session.prompt("第二句话：主角买了一张地图。请确认。");
	await session.prompt("第三句话：主角走进森林。请确认。");

	const entriesBefore = session.sessionManager.getEntries().filter((e) => e.type === "message");
	console.log(`> 压缩前 message 条目数: ${entriesBefore.length}`);

	// 可编程触发 compaction（manual 入口）。
	const result = await session.compact();

	console.log("--- compact() 返回值 ---");
	console.log(JSON.stringify(result, null, 2));
	console.log("--- session_before_compact 钩子收到的事件 ---");
	console.log(JSON.stringify(loader.hookEvents, null, 2));

	assert(loader.hookEvents.length === 1, "session_before_compact 钩子恰好触发一次");
	assert(loader.hookEvents[0]?.reason === "manual", "触发原因为 manual");
	assert(result.summary.includes(MARKER), "compact() 返回的 summary 含自定义标记");

	// 压缩条目落进 session（inMemory），fromHook=true。
	const branch = session.sessionManager.getBranch();
	const lastEntry = branch[branch.length - 1];
	assert(lastEntry !== undefined && lastEntry.type === "compaction", "分支末尾为 compaction 条目");
	const compactionEntry = lastEntry as CompactionEntry;
	assert(compactionEntry.summary.includes(MARKER), "compaction 条目 summary 含自定义标记");
	assert(compactionEntry.fromHook === true, "compaction 条目 fromHook === true（标记为扩展生成）");
	assert(!compactionEntry.summary.includes("## Goal"), "compaction 条目 summary 不含默认摘要结构（## Goal）");

	// 压缩后 buildSessionContext 证据。
	const ctx = session.sessionManager.buildSessionContext();
	console.log("--- 压缩后 buildSessionContext().messages（role + 文本节选） ---");
	const ctxTexts: string[] = [];
	for (const msg of ctx.messages) {
		const text = messageText(msg as { role: string; content?: unknown });
		ctxTexts.push(text);
		console.log(`[${msg.role}] ${text.slice(0, 120)}`);
	}
	const ctxAll = ctxTexts.join("\n");
	assert(ctxAll.includes(MARKER), "压缩后上下文（buildSessionContext）含自定义标记");
	assert(!ctxAll.includes("## Goal"), "压缩后上下文不含默认摘要结构（## Goal）");

	// agent.state.messages 同步更新（compact() 内部 :1880-1881）。
	const agentAll = session.state.messages.map((m) => messageText(m as { role: string; content?: unknown })).join("\n");
	assert(agentAll.includes(MARKER), "agent.state.messages 含自定义标记");

	// 最后一轮验证：模型实际看到自定义摘要。
	await session.prompt("这段对话的压缩摘要里提到的独特标记（MARKER 字符串）是什么？请原样复述该标记。");
	const reply = extractLastAssistantReply(session.state.messages) ?? "";
	console.log("--- 压缩后问模型标记 → 回复 ---");
	console.log(reply);
	assert(reply.includes(MARKER), "模型能从压缩后的上下文读出自定义标记");

	console.log("=== spike #7 全部断言通过 ===");
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
