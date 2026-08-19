// M0 spike #4：两路并行 inMemory session 隔离 + 零盘污染实测。
//
// 目的（技术路线 §4 spike 清单第 4 项 / §3.2 第 5 行）：
//   a) 共享单个 ModelRuntime，两路 createAgentSession + 各自 SessionManager.inMemory()，
//      并发 prompt（Promise.all），验证互不串台；
//   b) 实证「零盘污染」三件套（resourceLoader / settingsManager / modelRuntime）：
//      默认值仍读磁盘，实测哪些必须显式传隔离实例才能让 ~/.pi/agent/sessions/ 与
//      临时 cwd 无任何新文件（运行前后 diff）。
//
// 结论写在文件底部注释（由实际运行结果回填）。

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
	type LoadExtensionsResult,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const AGENT_DIR = getAgentDir();
const SESSIONS_DIR = join(AGENT_DIR, "sessions");

const DEFAULT_SETTINGS = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "high",
} as const;

// ---------------------------------------------------------------------------
// 隔离版 ResourceLoader：不读任何磁盘资源（AGENTS.md / skills / prompts / themes /
// extensions 全部为空），返回固定系统提示。实现 ResourceLoader 接口。
// ---------------------------------------------------------------------------
class IsolatedResourceLoader implements ResourceLoader {
	getExtensions(): LoadExtensionsResult {
		return { extensions: [], errors: [], runtime: createExtensionRuntime() };
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
		return "你是一个用于暗号隔离测试的助手。回答尽量简短（一两句话）。不要调用任何工具。";
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

/** 递归列出目录下全部文件（相对路径，排序）；目录不存在返回空。 */
function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(relative(dir, full));
		}
	};
	walk(dir);
	return out.sort();
}

function snapshotSessionsAndCwd(cwd: string): { sessions: string[]; cwd: string[] } {
	return { sessions: listFilesRecursive(SESSIONS_DIR), cwd: listFilesRecursive(cwd) };
}

function diffPaths(before: string[], after: string[]): string[] {
	const beforeSet = new Set(before);
	return after.filter((p) => !beforeSet.has(p));
}

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

/** 把整条会话转录压成纯文本（user/assistant 文本 + thinking），用于确定性隔离检查。 */
function transcriptText(messages: ReadonlyArray<{ role: string; content?: unknown }>): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			parts.push(msg.content);
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content as Array<{ type: string; text?: string; thinking?: string }>) {
			if (block.type === "text") parts.push(block.text ?? "");
			if (block.type === "thinking") parts.push(block.thinking ?? "");
		}
	}
	return parts.join("\n");
}

function makeTempCwd(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 主测试：两路并行 inMemory session，隔离三件套全部显式传入（= probe E 配置）。
// ---------------------------------------------------------------------------
async function parallelIsolationTest(): Promise<void> {
	const cwd = makeTempCwd("tavernpi-spike4-main-");
	const before = snapshotSessionsAndCwd(cwd);

	// 共享单个 ModelRuntime（create 一次，传给两路）。modelsPath: null → in-memory
	// models store，不读 models.json / models-store.json；仅读 auth.json（必须，读非写）。
	const modelRuntime = await ModelRuntime.create({ modelsPath: null });

	const mkOptions = (): CreateAgentSessionOptions => ({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ ...DEFAULT_SETTINGS }),
		resourceLoader: new IsolatedResourceLoader(),
		noTools: "all",
	});

	const [{ session: sessionA }, { session: sessionB }] = await Promise.all([
		createAgentSession(mkOptions()),
		createAgentSession(mkOptions()),
	]);

	// Round 1（并发）：各自声明身份与暗号。
	await Promise.all([
		sessionA.prompt("你叫A。你的暗号是红色。请记住并确认。"),
		sessionB.prompt("你叫B。你的暗号是蓝色。请记住并确认。"),
	]);

	// Round 2（并发）：互问对方暗号，验证互不串台。
	await Promise.all([
		sessionA.prompt("请分别回答：你的暗号是什么？B的暗号是什么？对于B的暗号，知道就说，不知道就回答「不知道」。"),
		sessionB.prompt("请分别回答：你的暗号是什么？A的暗号是什么？对于A的暗号，知道就说，不知道就回答「不知道」。"),
	]);

	const replyA = extractLastAssistantReply(sessionA.state.messages) ?? "";
	const replyB = extractLastAssistantReply(sessionB.state.messages) ?? "";
	const textA = transcriptText(sessionA.state.messages);
	const textB = transcriptText(sessionB.state.messages);

	console.log("--- A 回复 ---");
	console.log(replyA);
	console.log("--- B 回复 ---");
	console.log(replyB);

	const checks: Array<[string, boolean]> = [
		["A 知道自己的暗号（红色）", replyA.includes("红色")],
		["A 不知道 B 的暗号（回复不含蓝色）", !replyA.includes("蓝色")],
		["B 知道自己的暗号（蓝色）", replyB.includes("蓝色")],
		["B 不知道 A 的暗号（回复不含红色）", !replyB.includes("红色")],
		["A 转录隔离（全文不含蓝色）", !textA.includes("蓝色")],
		["B 转录隔离（全文不含红色）", !textB.includes("红色")],
	];
	for (const [label, ok] of checks) {
		console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
		if (!ok) throw new Error(`并行隔离断言失败：${label}`);
	}

	const after = snapshotSessionsAndCwd(cwd);
	const newInSessions = diffPaths(before.sessions, after.sessions);
	const newInCwd = diffPaths(before.cwd, after.cwd);
	console.log(`[主测试=全隔离配置] ~/.pi/agent/sessions/ 新增: ${newInSessions.length ? JSON.stringify(newInSessions) : "无"}`);
	console.log(`[主测试=全隔离配置] 临时 cwd 新增: ${newInCwd.length ? JSON.stringify(newInCwd) : "无"}`);

	rmSync(cwd, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 污染探针：同一 inMemory session + 1 条 prompt，分别只隔离 0/1/2 个选项，
// diff ~/.pi/agent/sessions/ 与临时 cwd。
// ---------------------------------------------------------------------------
interface ProbeResult {
	name: string;
	newInSessions: string[];
	newInCwd: string[];
}

async function runProbe(name: string, build: (cwd: string) => Promise<CreateAgentSessionOptions>): Promise<ProbeResult> {
	const cwd = makeTempCwd("tavernpi-spike4-probe-");
	const before = snapshotSessionsAndCwd(cwd);
	const options = await build(cwd);
	const { session } = await createAgentSession(options);
	await session.prompt("回复：OK");
	// 让潜在的异步写入落地后再快照。
	await new Promise((resolve) => setTimeout(resolve, 300));
	const after = snapshotSessionsAndCwd(cwd);
	const result: ProbeResult = {
		name,
		newInSessions: diffPaths(before.sessions, after.sessions),
		newInCwd: diffPaths(before.cwd, after.cwd),
	};
	rmSync(cwd, { recursive: true, force: true });
	return result;
}

async function pollutionProbes(): Promise<void> {
	const base = (cwd: string): CreateAgentSessionOptions => ({
		cwd,
		sessionManager: SessionManager.inMemory(cwd),
		noTools: "all",
	});

	const probes: Array<{ name: string; build: (cwd: string) => Promise<CreateAgentSessionOptions> }> = [
		{
			name: "A: 全默认（只传 inMemory sessionManager）",
			build: async (cwd) => base(cwd),
		},
		{
			name: "B: + 隔离 settingsManager",
			build: async (cwd) => ({
				...base(cwd),
				settingsManager: SettingsManager.inMemory({ ...DEFAULT_SETTINGS }),
			}),
		},
		{
			name: "C: + 隔离 resourceLoader",
			build: async (cwd) => ({ ...base(cwd), resourceLoader: new IsolatedResourceLoader() }),
		},
		{
			name: "D: + 隔离 modelRuntime（modelsPath:null）",
			build: async (cwd) => ({
				...base(cwd),
				modelRuntime: await ModelRuntime.create({ modelsPath: null }),
			}),
		},
	];

	for (const probe of probes) {
		const result = await runProbe(probe.name, probe.build);
		console.log(`[探针] ${result.name}`);
		console.log(`  ~/.pi/agent/sessions/ 新增: ${result.newInSessions.length ? JSON.stringify(result.newInSessions) : "无"}`);
		console.log(`  临时 cwd 新增: ${result.newInCwd.length ? JSON.stringify(result.newInCwd) : "无"}`);
	}
}

async function main(): Promise<void> {
	console.log("=== spike #4 主测试：两路并行 inMemory（全隔离配置） ===");
	await parallelIsolationTest();
	console.log();
	console.log("=== spike #4 零盘污染探针（各只隔离部分选项） ===");
	await pollutionProbes();
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});

// ===========================================================================
// 实测结论（2026-08-19 运行，deepseek/deepseek-v4-flash，6 项隔离断言全 PASS）
// ===========================================================================
// 1. 并行隔离 ✅：共享单个 ModelRuntime（modelsPath:null）+ 两路 inMemory，
//    Promise.all 并发 prompt。A 回复「红色；不知道」，B 回复「我的暗号是蓝色；
//    A的暗号不知道」。转录级检查：A 全文不含「蓝色」、B 全文不含「红色」。
//    两路互不串台成立。
//
// 2. 零盘污染实测 ✅（与技术路线 §3.2 字面断言存在差异，见下）：
//    探针 A（全默认，只传 inMemory sessionManager）→ ~/.pi/agent/sessions/ 与
//    临时 cwd 均【零新增文件】；B/C/D 同样零新增；全隔离主测试零新增。
//    即：仅用 SessionManager.inMemory()，三个默认项不会产生任何新文件。
//    佐证：运行后 ~/.pi/agent/models-store.json 的 mtime 仍停留在运行前
//    （默认 ModelRuntime 只读不写；写 models-store 仅发生在网络刷新 provider
//    catalog 时，allowModelNetwork 默认 false）。
//
//    差异说明：技术路线 §3.2 称「subagent 要零盘污染须显式传自定义
//    resourceLoader/settingsManager/model」。实测「零新文件」只需 inMemory
//    sessionManager 即可达成；显式传三件套的真正价值是【零读盘 / 上下文隔离】：
//    - 默认 settingsManager 读 ~/.pi/agent/settings.json（含 skills 路径等用户配置）；
//    - 默认 resourceLoader 读 cwd 的 AGENTS.md、settings.json 引用的 skills/prompts、
//      ~/.pi/agent 下的 SYSTEM.md / themes / extensions（本测试 temp cwd 无
//      AGENTS.md，但真实场景 cwd=项目目录时会读到项目 AGENTS.md 与 .pi 资源）；
//    - 默认 ModelRuntime 读 auth.json / models.json / models-store.json。
//    这些都是「读」而非「写」。防写盘靠 inMemory；防读盘/防上下文污染仍需显式
//    传隔离三件套（本脚本 IsolatedResourceLoader + SettingsManager.inMemory +
//    ModelRuntime.create({modelsPath:null}) 即为此范式）。
//
// 3. 禁调 session.reload()：本脚本未调用（§3.2 警告：reload 会清全局 provider
//    注册表，殃及并行会话）。
