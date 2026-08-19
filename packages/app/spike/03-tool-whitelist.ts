// M0 spike #3：工具白名单 —— 禁全部内置工具，只留两个自定义叙事工具，验证模型真实调用。
//
// 白名单语义（sdk.ts:247-254 + agent-session.ts _refreshToolRegistry():2463-2553 核实）：
//   `tools: [...]` 作为严格 allowlist：isAllowedTool = (!allowedToolNames || 命中) && !excluded，
//   对 builtin（read/bash/edit/write/grep/find/ls）+ extension + custom 全部来源统一过滤；
//   未列入的工具既不注册也不激活。customTools 同样过这个过滤，故只剩 write_event/read_state 存活。
//   不用 noTools:"all"：那会把 allowedToolNames 置为 []，连自定义工具一起杀掉。
//
// typebox：ToolDefinition.parameters 是 typebox TSchema（extensions/types.ts:449-462），
//   运行期即 JSON Schema 对象，pi 侧按 json_schema 做 constrained sampling（ai/constrained-sampling.ts）。
//   本 spike 从 pi 依赖里导入 typebox（1.3.7，ESM-only），不额外声明 app 依赖。
//   导入路径经由 node_modules 嵌套布局解析（类型声明走同目录 .d.mts）。

import {
	createAgentSession,
	defineTool,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs";

const SYSTEM_PROMPT = `你是 tavernpi 故事引擎的叙事执笔者，把玩家行动转化为叙事事件并记录到事件存储。

你拥有两个工具：
- write_event(summary, detail)：写入一条叙事事件。summary 是一句话摘要，detail 是细节描述。
- read_state()：读取当前已记录的全部事件。

当玩家行动产生值得记录的事件时，必须调用 write_event；被问及已发生的事实时调用 read_state。`;

const PROMPT_TEXT =
	"记录一个事件：主角推开了城门，沉重的木门发出吱呀声，露出通往城外的长街。记录完成后调用 read_state 查看已记录内容。";

// 进程内模拟事件存储（SQLite 是 P3 的事）。
interface StoredEvent {
	seq: number;
	summary: string;
	detail: string;
}
const events: StoredEvent[] = [];
let eventSeq = 0;

const writeEventTool = defineTool({
	name: "write_event",
	label: "写入事件",
	description: "把一条叙事事件写入事件存储。必须提供 summary（一句话摘要）与 detail（细节描述）。",
	promptSnippet: "write_event: 写入一条叙事事件（summary/detail）",
	promptGuidelines: ["当玩家行动产生值得记录的事件时，调用 write_event"],
	parameters: Type.Object(
		{
			summary: Type.String({ description: "事件的一句话摘要" }),
			detail: Type.String({ description: "事件的细节描述" }),
		},
		{ additionalProperties: false },
	),
	execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
		eventSeq += 1;
		const seq = eventSeq;
		events.push({ seq, summary: params.summary, detail: params.detail });
		return {
			content: [{ type: "text", text: `已记录事件 #${seq}: ${params.summary}` }],
			details: { seq, summary: params.summary, detail: params.detail },
		};
	},
});

const readStateTool = defineTool({
	name: "read_state",
	label: "读取事件存储",
	description: "返回当前事件存储中的全部事件（含序号、摘要与细节）。",
	promptSnippet: "read_state: 读取已记录的全部事件",
	promptGuidelines: ["在回应用户关于已发生事件的询问前，调用 read_state 取得事实"],
	parameters: Type.Object({}, { additionalProperties: false }),
	execute: async () => {
		const text = events.map((e) => `#${e.seq} ${e.summary}：${e.detail}`).join("\n") || "(空)";
		return {
			content: [{ type: "text", text }],
			details: { events: [...events] },
		};
	},
});

interface ToolCallTrace {
	name: string;
	arguments: Record<string, unknown>;
}
interface ToolResultTrace {
	toolName: string;
	text: string;
}

/** 扫描转录中的 toolCall / toolResult 痕迹（AgentMessage 结构见 pi-ai Message 联合类型）。 */
function scanToolTraces(messages: ReadonlyArray<{ role: string; content?: unknown }>): {
	toolCalls: ToolCallTrace[];
	toolResults: ToolResultTrace[];
} {
	const toolCalls: ToolCallTrace[] = [];
	const toolResults: ToolResultTrace[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const item of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
				if (item.type === "toolCall") {
					toolCalls.push({ name: item.name ?? "?", arguments: (item.arguments ?? {}) as Record<string, unknown> });
				}
			}
		} else if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			const text = (msg.content as Array<{ type?: string; text?: string }>)
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("");
			toolResults.push({ toolName: (msg as { toolName?: string }).toolName ?? "?", text });
		}
	}
	return { toolCalls, toolResults };
}

/** 从会话转录里取最后一条含文本的 assistant 回复（全文）。 */
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

async function main(): Promise<void> {
	const cwd = process.cwd();
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => SYSTEM_PROMPT,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader: loader,
		customTools: [writeEventTool, readStateTool],
		tools: ["write_event", "read_state"],
	});
	if (modelFallbackMessage) {
		console.error(`[warn] ${modelFallbackMessage}`);
	}
	console.log(`> model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`);
	console.log(`> 白名单激活工具: [${session.getActiveToolNames().join(", ")}]`);

	await session.prompt(PROMPT_TEXT);

	const { toolCalls, toolResults } = scanToolTraces(session.state.messages);

	console.log("=== 工具调用痕迹 ===");
	if (toolCalls.length === 0) {
		console.log("(无 toolCall)");
	} else {
		for (const call of toolCalls) {
			console.log(`- toolCall: ${call.name}(${JSON.stringify(call.arguments)})`);
		}
	}
	if (toolResults.length === 0) {
		console.log("(无 toolResult)");
	} else {
		for (const res of toolResults) {
			console.log(`- toolResult: ${res.toolName} => ${res.text.replaceAll("\n", " ⏎ ")}`);
		}
	}

	const wroteEvent = toolCalls.some((c) => c.name === "write_event");
	const readBack = toolCalls.some((c) => c.name === "read_state");
	if (!wroteEvent) {
		throw new Error("模型未调用 write_event，白名单验证失败");
	}
	if (!readBack) {
		throw new Error("模型未调用 read_state，回读验证失败");
	}

	console.log("--- 回复 ---");
	console.log(extractLastAssistantReply(session.state.messages) ?? "(无文本回复)");
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
