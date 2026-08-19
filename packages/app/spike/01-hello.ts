// M0 spike #1：最小 createAgentSession 对话。
//
// 目的：复验「SDK 应用形态」基座（创作规划 §8.1 / 技术路线 §3.2）——
// 用最省配置跑通 createAgentSession → prompt → 取回模型回复。
//
// 配置说明：
// - 不传 modelRuntime / model：默认 ModelRuntime.create() 读 ~/.pi/agent/auth.json 与 models.json，
//   初始模型取 settings.json 的 defaultProvider/defaultModel（findInitialModel）。
// - SessionManager.inMemory()：会话转录只存内存，不落盘（技术路线 §3.2 第 4 行）。
// - 本 spike 刻意不做 resourceLoader / systemPrompt override（那是 spike #2），
//   因此系统提示含 pi 默认内容与 AGENTS.md 上下文，回复偏「编码助手」是预期行为。

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const PROMPT_TEXT = "用一句话介绍你自己";

function formatModel(model: { provider: string; id: string } | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown";
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
	const { session, modelFallbackMessage } = await createAgentSession({
		sessionManager: SessionManager.inMemory(),
	});

	if (modelFallbackMessage) {
		console.error(`[warn] ${modelFallbackMessage}`);
	}

	console.log(`> prompt: ${PROMPT_TEXT}`);
	console.log(`> model: ${formatModel(session.model)}`);

	await session.prompt(PROMPT_TEXT);

	const reply = extractLastAssistantReply(session.state.messages);
	if (reply === undefined) {
		throw new Error("未取到 assistant 文本回复");
	}

	console.log(`> reply model: ${formatModel(session.model)}`);
	console.log("--- reply ---");
	console.log(reply);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
