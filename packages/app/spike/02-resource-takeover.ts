// M0 spike #2：资源接管 —— 实际发出的 system prompt = packages/core/prompts/narrator.md，验证「编程导向零残留」。
//
// 方案：override 四件套（DefaultResourceLoader 选项），源码核实的组装路径：
//   - resource-loader.ts:527  systemPromptOverride(base) 整体替换 loader 的 systemPrompt 槽；
//     agentsFilesOverride / skillsOverride / promptsOverride 同理清空 context files / skills / prompts 槽。
//   - agent-session.ts _rebuildSystemPrompt():1039-1056 把这些槽喂给 buildSystemPrompt()；
//   - system-prompt.ts:46-71  customPrompt 分支 = override 结果 + append 段 + <project_context>(contextFiles)
//     + skills 段（仅当 read 工具启用且有 skills）+ 硬编码的 `\nCurrent working directory: <cwd>\n`。
//
// 捕获通道：注册 inline extension 监听 before_agent_start 事件。
//   agent-session.ts prompt():1233-1261 在每次 LLM 调用前 emitBeforeAgentStart(..., this._baseSystemPrompt, options)，
//   事件的 systemPrompt 字段 = 组装完成、即将发给模型的最终 system prompt；本脚本不改写它，
//   故事件值 == agent.state.systemPrompt == 实际发出内容。打印后与 session.systemPrompt getter 交叉核对。
//
// 已知残留（源码确认）：customPrompt 分支无条件追加 `\nCurrent working directory: <cwd>\n`，cwd 行不可剔除。
//   性质判定：纯信息行（无指令、无上下文文件、无 skills），不构成编程导向内容，判定为零残留（除该无害行）。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const repoRoot = resolve(import.meta.dirname, "../../..");
const narratorPath = resolve(repoRoot, "packages/core/prompts/narrator.md");
const narratorContent = readFileSync(narratorPath, "utf-8");

const PROMPT_TEXT = "你是谁？用一句话回答。";

/** 判定捕获到的 system prompt 中相对 narrator 的残留增量及其性质。 */
function analyzeResidual(full: string, base: string): string[] {
	const residual = full.slice(base.length);
	const verdict: string[] = [];
	if (residual.length === 0) {
		verdict.push("无残留增量（system prompt 与 narrator.md 完全一致）");
		return verdict;
	}
	const markers = [
		["<project_context>", "project_context（AGENTS.md 等上下文文件）"],
		["Available tools:", "默认工具清单段"],
		["Guidelines:", "默认指导段"],
		["<skill ", "skills 段"],
		["Current working directory:", "cwd 信息行"],
	] as const;
	const found = markers.filter(([m]) => residual.includes(m) || full.includes(m));
	if (found.length === 0) {
		verdict.push(`存在未识别残留增量（${residual.length} 字符），请人工核对`);
		return verdict;
	}
	for (const [, label] of found) {
		const isCwd = label === "cwd 信息行";
		verdict.push(
			`${isCwd ? "[可接受·信息性]" : "[残留·编程导向]"} 检测到：${label}`,
		);
	}
	return verdict;
}

async function main(): Promise<void> {
	const cwd = repoRoot;
	const captured: { systemPrompt?: string } = {};

	const observer: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("before_agent_start", (event) => {
			captured.systemPrompt = event.systemPrompt;
		});
	};

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => narratorContent,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
		appendSystemPromptOverride: () => [],
		extensionFactories: [observer],
	});
	// 自定义 resourceLoader 须自行 reload（sdk.ts 只在未传入时自动 reload）；reload 幂等。
	await loader.reload();

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		resourceLoader: loader,
	});
	if (modelFallbackMessage) {
		console.error(`[warn] ${modelFallbackMessage}`);
	}
	console.log(`> model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`);

	await session.prompt(PROMPT_TEXT);

	const capturedPrompt = captured.systemPrompt;
	if (capturedPrompt === undefined) {
		throw new Error("未捕获到 before_agent_start 事件（未产生 LLM 调用）");
	}
	const statePrompt = session.systemPrompt;
	console.log(
		`> 捕获核对: before_agent_start.length=${capturedPrompt.length} vs session.systemPrompt.length=${statePrompt.length}`,
	);
	if (capturedPrompt !== statePrompt) {
		console.error("[warn] 事件捕获与 session.systemPrompt 不一致，以事件捕获为准");
	}

	console.log("=== 实际发出的完整 system prompt（含全部残留） ===");
	console.log(capturedPrompt);
	console.log("=================================================");

	console.log("=== 残留判定 ===");
	for (const line of analyzeResidual(capturedPrompt, narratorContent)) {
		console.log(`- ${line}`);
	}

	console.log("--- 回复 ---");
	const reply = extractLastAssistantReply(session.state.messages);
	if (reply === undefined) {
		throw new Error("未取到 assistant 文本回复");
	}
	console.log(reply);
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

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
