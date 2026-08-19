// M0 demo：技术路线 §4.1 spike 验收单 —— 终端 CLI 循环，单 agent、无 pipeline。
//
// 启动（override 四件套路线，02 spike 已验证；tools 白名单，03 spike 已验证）：
// - systemPrompt = packages/core/prompts/narrator.md（systemPromptOverride）+ demo 附加约定（append 槽）；
//   agentsFiles / skills / prompts 槽清空。启动即打印实际发出的完整 system prompt
//   （session.systemPrompt，AgentSession 构造时已组装，agent-session.ts:941-942），
//   并以 before_agent_start 事件（agent-session.ts:1233-1261）首次捕获交叉核对「零编程导向残留」。
// - tools: ["write_event","read_state"] 严格白名单，禁全部内置工具（sdk.ts:247-254、
//   agent-session.ts _refreshToolRegistry():2463-2553）；仅注册两个自定义叙事工具（typebox 参数 schema）。
// - node:sqlite（Node ≥24 内置）打开 mkdtemp 临时 story.db，建 events / meta 两表；结束 rmSync 清理。
//
// 工具：
// - write_event(summary, detail)：追加 events 行；turn_seq 由工具从 meta 表自增，模型不接触。
// - read_state()：返回 events 全表 + 当前轮数（meta.turn_seq）。
//
// 双模式：
// - 默认/CI：脚本化验收 —— 5 轮固定输入（含「现在发生过什么？」轮），每轮打印正文 + 本轮 DB 变更，
//   结尾打印 PASS/FAIL 检查表；非交互、退出码正确。
// - --interactive 或 stdin 为 TTY：readline 自由输入（人工使用）。
// - --persist：session 落盘到 mkdtemp 临时目录（不写 ~/.pi/agent/sessions），验证持久化形态。

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const persist = args.includes("--persist");
const interactive = args.includes("--interactive");
const forceScripted = args.includes("--scripted");
const isTTY = process.stdin.isTTY === true;
const useInteractive = interactive || (isTTY && !forceScripted);

// ---------------------------------------------------------------------------
// 固定资源
// ---------------------------------------------------------------------------
const repoRoot = resolve(import.meta.dirname, "../../..");
const narratorPath = resolve(repoRoot, "packages/core/prompts/narrator.md");
const narratorContent = readFileSync(narratorPath, "utf-8");

// demo 附加约定（append 槽）：成本控制 + 引导工具使用。narrator.md 本体不动。
const DEMO_APPEND = [
	"（M0 demo 约定）保持简短：每轮正文不超过 3 句。",
	"产生值得记录的事件时调用 write_event(summary, detail) 落库；被问及已发生的事实（如「现在发生过什么」）时，先调用 read_state() 取得事实再作答，不得编造。",
];

// ---------------------------------------------------------------------------
// story.db：mkdtemp 临时目录 + node:sqlite
// ---------------------------------------------------------------------------
interface EventRow {
	id: number;
	turn_seq: number;
	summary: string;
	detail: string;
}

class StoryDb {
	readonly dir: string;
	readonly db: DatabaseSync;
	private readonly insertEvent;
	private readonly allEventsStmt;
	private readonly getTurnStmt;
	private readonly setTurnStmt;

	constructor() {
		this.dir = mkdtempSync(join(tmpdir(), "tavernpi-m0-"));
		this.db = new DatabaseSync(join(this.dir, "story.db"));
		this.db.exec(`
			CREATE TABLE events (id INTEGER PRIMARY KEY, turn_seq INTEGER, summary TEXT, detail TEXT);
			CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
		`);
		this.insertEvent = this.db.prepare(
			"INSERT INTO events (turn_seq, summary, detail) VALUES (?, ?, ?)",
		);
		this.allEventsStmt = this.db.prepare(
			"SELECT id, turn_seq, summary, detail FROM events ORDER BY id",
		);
		this.getTurnStmt = this.db.prepare("SELECT v FROM meta WHERE k = 'turn_seq'");
		this.setTurnStmt = this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('turn_seq', ?)");
	}

	/** 当前轮数（meta.turn_seq，0 = 尚无写入）。 */
	getTurn(): number {
		const row = this.getTurnStmt.get() as { v: string } | undefined;
		return row ? Number(row.v) : 0;
	}

	/** 追加事件行：turn_seq 由工具自增（不暴露给模型）。 */
	writeEvent(summary: string, detail: string): { id: number; turnSeq: number } {
		const turnSeq = this.getTurn() + 1;
		this.setTurnStmt.run(String(turnSeq));
		const res = this.insertEvent.run(turnSeq, summary, detail);
		return { id: Number(res.lastInsertRowid), turnSeq };
	}

	allEvents(): EventRow[] {
		return this.allEventsStmt.all() as unknown as EventRow[];
	}

	close(): void {
		this.db.close();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// 工具定义（typebox 参数 schema，白名单 [write_event, read_state]）
// ---------------------------------------------------------------------------
interface ToolCallTrace {
	name: string;
	arguments: Record<string, unknown>;
}
interface ToolResultTrace {
	toolName: string;
	text: string;
}

/** 扫描一段转录中的 toolCall / toolResult 痕迹。 */
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

/** 从转录中取最后一条含文本的 assistant 回复（全文）。 */
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
	const storyDb = new StoryDb();

	const writeEventTool = defineTool({
		name: "write_event",
		label: "写入事件",
		description:
			"把一条叙事事件写入 story.db 的 events 表。必须提供 summary（一句话摘要）与 detail（细节描述）。turn_seq 由工具自动从 meta 表自增，你不需要提供。",
		promptSnippet: "write_event: 写入一条叙事事件（summary/detail）",
		promptGuidelines: ["产生值得记录的事件时调用 write_event 落库"],
		parameters: Type.Object(
			{
				summary: Type.String({ description: "事件的一句话摘要" }),
				detail: Type.String({ description: "事件的细节描述" }),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			const { id, turnSeq } = storyDb.writeEvent(params.summary, params.detail);
			return {
				content: [{ type: "text", text: `已记录事件 #${id}（turn_seq=${turnSeq}）: ${params.summary}` }],
				details: { id, turnSeq, summary: params.summary, detail: params.detail },
			};
		},
	});

	const readStateTool = defineTool({
		name: "read_state",
		label: "读取事件存储",
		description: "返回 story.db events 表全部事件（按 id 升序）与当前轮数（meta.turn_seq）。",
		promptSnippet: "read_state: 读取已记录的全部事件与当前轮数",
		promptGuidelines: ["在回应用户关于已发生事实的询问前，先调用 read_state 取得事实"],
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const events = storyDb.allEvents();
			const turn = storyDb.getTurn();
			const text =
				events.length === 0
					? "(空)"
					: events.map((e) => `#${e.id} turn${e.turn_seq} ${e.summary}：${e.detail}`).join("\n");
			return {
				content: [{ type: "text", text: `当前轮数: ${turn}\n${text}` }],
				details: { turn, events },
			};
		},
	});

	// before_agent_start 捕获通道（启动打印的交叉核对）
	const captured: { systemPrompt?: string } = {};
	const observer: (pi: ExtensionAPI) => void = (pi) => {
		pi.on("before_agent_start", (event) => {
			if (captured.systemPrompt === undefined) {
				captured.systemPrompt = event.systemPrompt;
			}
		});
	};

	const loader = new DefaultResourceLoader({
		cwd: repoRoot,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => narratorContent,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
		appendSystemPromptOverride: () => DEMO_APPEND,
		extensionFactories: [observer],
	});
	await loader.reload();

	// 会话形态：inMemory（默认）或 persist（mkdtemp 落盘）
	const tempDirs: string[] = [];
	let sessionManager: SessionManager;
	if (persist) {
		const sessionDir = mkdtempSync(join(tmpdir(), "tavernpi-m0-session-"));
		tempDirs.push(sessionDir);
		sessionManager = SessionManager.create(repoRoot, sessionDir);
	} else {
		sessionManager = SessionManager.inMemory(repoRoot);
	}

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: repoRoot,
		sessionManager,
		resourceLoader: loader,
		customTools: [writeEventTool, readStateTool],
		tools: ["write_event", "read_state"],
	});
	if (modelFallbackMessage) {
		console.error(`[warn] ${modelFallbackMessage}`);
	}

	console.log(`> 形态: ${persist ? "persist（落盘 mkdtemp）" : "inMemory"}`);
	console.log(`> model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`);
	console.log(`> 工具白名单: [${session.getActiveToolNames().join(", ")}]`);
	console.log(`> story.db: ${join(storyDb.dir, "story.db")}`);

	// 启动打印：实际发出的完整 system prompt（组装结果，before_agent_start 首捕交叉核对）
	console.log("=== 实际发出的完整 system prompt（含 demo 附加约定与 pi 残留行） ===");
	console.log(session.systemPrompt);
	console.log("=== end system prompt ===");

	try {
		if (useInteractive) {
			await runInteractive(session, storyDb);
		} else {
			const reports = await runScripted(session, storyDb);
			printChecklist(reports, session);
		}
		// 交叉核对：before_agent_start 首捕 vs 启动打印的组装结果（02 spike 结论的复核）
		if (captured.systemPrompt === undefined) {
			console.log("> [warn] before_agent_start 未触发，无法交叉核对 system prompt");
		} else {
			const match = captured.systemPrompt === session.systemPrompt;
			console.log(
				`> system prompt 交叉核对: ${match ? "一致" : "不一致"}（before_agent_start=${captured.systemPrompt.length} 字 vs 启动打印=${session.systemPrompt.length} 字）`,
			);
		}
	} finally {
		// persist 形态证据（清理前）
		if (persist) {
			console.log(`--- persist 会话文件（${tempDirs[0]!}） ---`);
			for (const f of readdirSync(tempDirs[0]!)) {
				console.log(`  ${f}`);
			}
		}
		session.dispose();
		storyDb.close();
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

// ---------------------------------------------------------------------------
// 单轮（供脚本化与交互共用）
// ---------------------------------------------------------------------------
interface SessionLike {
	prompt(text: string): Promise<void>;
	state: { messages: ReadonlyArray<{ role: string; content?: unknown }> };
}

interface TurnReport {
	index: number;
	input: string;
	reply: string;
	toolCalls: ToolCallTrace[];
	toolResults: ToolResultTrace[];
	dbChanges: EventRow[];
	/** 本轮开始前 events 表中的事件（read_state 回应轮可读到的事实集）。 */
	eventsBefore: EventRow[];
}

async function runOneTurn(session: SessionLike, storyDb: StoryDb, index: number, input: string): Promise<TurnReport> {
	const beforeCount = session.state.messages.length;
	const eventsBefore = storyDb.allEvents();
	await session.prompt(input);
	const newMessages = session.state.messages.slice(beforeCount);
	const traces = scanToolTraces(newMessages);
	const reply = extractLastAssistantReply(newMessages) ?? "";
	const eventsAfter = storyDb.allEvents();
	const dbChanges = eventsAfter.slice(eventsBefore.length);

	console.log(`\n========== 第 ${index} 轮 ==========`);
	console.log(`> 输入: ${input}`);
	console.log("--- 正文 ---");
	console.log(reply);
	console.log("--- 本轮 DB 变更 ---");
	if (dbChanges.length === 0) {
		console.log("(无)");
	} else {
		for (const e of dbChanges) {
			console.log(`+ events#${e.id} turn_seq=${e.turn_seq}: ${e.summary}`);
		}
	}
	console.log(
		`--- 工具调用: ${traces.toolCalls.length === 0 ? "(无)" : traces.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(" ")}`,
	);

	return { index, input, reply, toolCalls: traces.toolCalls, toolResults: traces.toolResults, dbChanges, eventsBefore };
}

// ---------------------------------------------------------------------------
// 脚本化验收
// ---------------------------------------------------------------------------
const SCRIPTED_TURNS = [
	"主角推开城门，走进这座荒废的王城。请记录这个事件。",
	"现在发生过什么？",
	"主角在庭院里发现一口枯井，井边刻着陌生的符文。请记录这个事件。",
	"主角走向王座大厅，那里的壁炉还燃着余火。请记录这个事件。",
	"现在发生过什么？",
];

async function runScripted(session: SessionLike, storyDb: StoryDb): Promise<TurnReport[]> {
	console.log("\n===== 脚本化验收：5 轮 =====");
	const reports: TurnReport[] = [];
	for (const [i, input] of SCRIPTED_TURNS.entries()) {
		reports.push(await runOneTurn(session, storyDb, i + 1, input));
	}
	return reports;
}

// ---------------------------------------------------------------------------
// PASS/FAIL 检查表
// ---------------------------------------------------------------------------
interface CheckItem {
	name: string;
	status: "PASS" | "FAIL" | "待人工核对";
	detail?: string;
}

function printChecklist(reports: TurnReport[], session: { getActiveToolNames(): string[] }): void {
	const checks: CheckItem[] = [];

	checks.push({ name: "5 轮全部完成", status: reports.length === 5 ? "PASS" : "FAIL" });

	const active = session.getActiveToolNames();
	const whitelistOk = active.length === 2 && active.includes("write_event") && active.includes("read_state");
	checks.push({
		name: "工具白名单：仅 write_event/read_state（无内置 read/bash/edit/write）",
		status: whitelistOk ? "PASS" : "FAIL",
		detail: `[${active.join(", ")}]`,
	});

	const allCalls = reports.flatMap((r) => r.toolCalls);
	const writeCalls = allCalls.filter((c) => c.name === "write_event");
	checks.push({
		name: "write_event 至少被调用一次",
		status: writeCalls.length > 0 ? "PASS" : "FAIL",
		detail: `共 ${writeCalls.length} 次`,
	});

	const eventRows = reports.flatMap((r) => r.dbChanges);
	checks.push({
		name: "events 表有落库写入",
		status: eventRows.length > 0 ? "PASS" : "FAIL",
		detail: `共 ${eventRows.length} 行`,
	});

	const stateTurns = reports.filter((r) => r.input.includes("现在发生过什么"));
	for (const r of stateTurns) {
		const called = r.toolCalls.some((c) => c.name === "read_state");
		checks.push({
			name: `第 ${r.index} 轮（现在发生过什么）调用了 read_state`,
			status: called ? "PASS" : "FAIL",
		});

		// 无编造检查：read_state 轮回复是否覆盖「该轮开始前」已记录事件的全部摘要（自动可查）。
		// read_state 返回的正是这些摘要；摘要以原文出现在回复中 = 引用事实、无编造；
		// 措辞改写导致未全覆盖则标注待人工核对。
		const summaries = r.eventsBefore.map((e) => e.summary);
		const covered = summaries.length > 0 && summaries.every((s) => r.reply.includes(s));
		checks.push({
			name: `第 ${r.index} 轮回复与 events 表一致（覆盖轮前 ${summaries.length} 条摘要）`,
			status: covered ? "PASS" : "待人工核对",
			detail: covered ? undefined : "摘要未全覆盖，措辞可能改写——请人工核对是否编造",
		});
	}

	let failed = 0;
	console.log("\n===== M0 demo 验收检查表 =====");
	for (const c of checks) {
		const mark = c.status === "PASS" ? "✓" : c.status === "FAIL" ? "✗" : "?";
		console.log(`[${mark} ${c.status}] ${c.name}${c.detail ? ` —— ${c.detail}` : ""}`);
		if (c.status === "FAIL") failed++;
	}
	console.log(`===== 结果: ${failed === 0 ? "PASS" : "FAIL"}（${checks.filter((c) => c.status === "PASS").length}/${checks.length} 通过） =====`);
	if (failed > 0) {
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// 交互模式（人工使用）
// ---------------------------------------------------------------------------
async function runInteractive(session: SessionLike, storyDb: StoryDb): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	console.log("\n===== 交互模式：输入行动/对话，空行退出 =====");
	let index = 1;
	for (;;) {
		const input = await rl.question("> ");
		if (!input.trim()) break;
		await runOneTurn(session, storyDb, index++, input.trim());
	}
	rl.close();
	console.log("已退出。");
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
