// M2 交互 CLI（人工验收入口，创作规划 §7-M2）：data subagent 叙事循环 + StoryRuntime 编排器。
//
// 目的：验收 §6.1 契约——data 每轮自动抽取落库（时间推进与校验）；失败路径（重试/不拍快照/
// 下轮补齐/连续失败提示）；「10 轮后 DB 正确反映剧情」。
// 接线（app 层只消费 core API）：
//   SessionManager ↔ StoryDb ↔ SnapshotsDb ↔ createStoryRuntime（§10.2 API 面 M2 形态）
//     ├── 主叙事 AgentSession（零 DB 工具，before_agent_start 每轮注入 DB 摘要）
//     └── runDataStage（data subagent：submit_changeset 单输出工具 + 重试/补齐/事件流）
//   eventLog = pipeline-events.jsonl（故事目录内）；settings = ~/.tavernpi/settings.json（§6.6）。
//
// 关键决策（与 m1-cli 一致，详见 core pipeline/runtime.ts 文件头）：
// - 快照绑定本轮 leaf（最终 assistant entry），与 turn_log 同一 id；
// - data 成功才拍快照（§6.1：拍摄前提 = 落库成功），失败轮记 data_status.failed、下轮补齐；
// - 主叙事零工具：启动打印工具白名单（应为空）。
// - fork 流程：createBranchedSession → forkStoryDb → dispose 旧运行态 → 新故事目录重建
//   StoryRuntime（settings/prompts/eventLog 重新传入，新目录新 eventLog 文件）。
//
// 坑（同 m1-cli）：
// - session.prompt 必须 await 完（isStreaming=false）才能 navigateTree（spike/05 实证）。
// - 退出不删故事目录——人工验收要可重复进入（--resume 会话文件）。
// - 恢复（restore）用新 StoryDb 实例替换旧连接；任何长期持有 storyDb 的闭包都会读到已关闭连接。

import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildAncestorChain,
	createPipelineEventLog,
	createStoryRuntime,
	defaultGlobalPromptsDir,
	defaultStoriesRoot,
	forkStoryDb,
	loadSettings,
	openSnapshotsDb,
	openStoryDb,
	snapshotsDbPath,
	storyDbPath as coreStoryDbPath,
	type PromptLayerDirs,
	type SnapshotRestoreResult,
	type StoryRuntime,
	type StoryState,
	type TavernSettings,
	type TurnResult,
} from "@tavernpi/core";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, "../../..");

interface CliArgs {
	root?: string;
	sessionDir?: string;
	resume?: string;
}

interface CliCtx {
	storiesRoot: string;
	cwd: string;
	settings: TavernSettings;
	modelRuntime: ModelRuntime;
	prompts: PromptLayerDirs;
}

// ---------------------------------------------------------------------------
// 文本/转录工具（沿 m1-cli）
// ---------------------------------------------------------------------------

function messageText(message: { role: string; content?: unknown }): string {
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

function messageEntries(sessionManager: SessionManager): Array<Extract<SessionEntry, { type: "message" }>> {
	return sessionManager.getEntries().filter((e) => e.type === "message") as Array<
		Extract<SessionEntry, { type: "message" }>
	>;
}

function resolveTreeTarget(sessionManager: SessionManager, arg: string): Extract<SessionEntry, { type: "message" }> {
	const entries = messageEntries(sessionManager);
	if (/^\d+$/.test(arg)) {
		const idx = Number(arg);
		const entry = entries[idx - 1];
		if (!entry) throw new Error(`序号 ${arg} 超出范围（共 ${entries.length} 条消息）`);
		return entry;
	}
	const hit = entries.find((e) => e.id.startsWith(arg));
	if (!hit) throw new Error(`找不到 entry id 前缀: ${arg}`);
	return hit;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// CLI 命令
// ---------------------------------------------------------------------------

function printTree(sessionManager: SessionManager): void {
	const entries = messageEntries(sessionManager);
	const leafId = sessionManager.getLeafId();
	console.log(`--- branch（${entries.length} 条消息）---`);
	for (const [i, e] of entries.entries()) {
		const mark = e.id === leafId ? " *" : "";
		const text = truncate(messageText(e.message), 40);
		console.log(`#${i + 1} [${e.message.role}]${mark} ${text}  (${e.id.slice(0, 8)})`);
	}
}

function printRestoreResult(result: SnapshotRestoreResult | undefined, runtime: StoryRuntime): void {
	const clock = runtime.storyState.storyDb.reader.getClock();
	const events = runtime.storyState.storyDb.reader.listEvents();
	if (result === undefined) {
		console.log("> 恢复结果: 未执行（无钩子状态）");
	} else if (!result.ok) {
		console.log(`> 恢复失败: ${result.error ?? "未知错误"}`);
	} else if (result.restoredTurnSeq !== undefined) {
		console.log(`> 恢复成功: turn${result.restoredTurnSeq}（entry ${result.restoredEntryId}）`);
	} else {
		console.log("> 恢复成功（空库兜底，§3.1）");
	}
	console.log(`> 当前 clock: ${clock?.current_time ?? "(未初始化)"}，events: ${events.length} 行`);
}

function printStatus(runtime: StoryRuntime): void {
	const { sessionManager, storyState } = runtime;
	const clock = storyState.storyDb.reader.getClock();
	const events = storyState.storyDb.reader.listEvents();
	const turns = storyState.storyDb.reader.getTurnLog();
	const snaps = storyState.snapshotsDb.listSnapshots();
	const dataStatus = storyState.storyDb.reader.listDataStatus();
	console.log("--- status ---");
	console.log(`sessionId: ${sessionManager.getSessionId()}`);
	console.log(`sessionFile: ${sessionManager.getSessionFile()}`);
	console.log(`leafId: ${sessionManager.getLeafId()}`);
	console.log(`storyDir: ${storyState.storyDir}`);
	console.log(`clock: ${clock ? `${clock.current_time}（${clock.calendar}/${clock.granularity}）` : "(未初始化)"}`);
	console.log(
		`events: ${events.length} 行 | turn_log: ${turns.length} 行 | snapshots: ${snaps.length} 份 | data_status: ${dataStatus.length} 行`,
	);
}

function printHelp(): void {
	console.log(
		[
			"可用命令：",
			"  /tree              列出当前 branch 的消息条目（序号 + role + 摘要 + entry id 前 8 位）",
			"  /tree <序号|entryId>  跳转到目标条目（user 目标 → 重做该轮，恢复其前一轮末状态；assistant 目标 → 该轮末状态），钩子自动恢复 DB",
			"  /fork <序号|entryId>  从目标条目分叉新故事（user 目标 = 其前分叉重问）",
			"  /status             打印 sessionId / leafId / clock / 行数（含 data_status）",
			"  /help               本帮助",
			"  空行                退出（不删故事目录，可 --resume 续写）",
			"",
			"data subagent（§6.1）：每轮叙事后自动抽取落库；失败会重试并在下轮补齐，不阻塞叙事。",
			"事件流留痕见故事目录 pipeline-events.jsonl。",
		].join("\n"),
	);
}

function printTurn(report: TurnResult): void {
	console.log(`\n========== 第 ${report.turnSeq} 轮 ==========`);
	console.log("--- 正文 ---");
	console.log(report.narrativeText);
	console.log("--- data 落库（§6.1） ---");
	if (report.data.ok) {
		const a = report.data.applied;
		console.log(
			`✓ 成功（attempts=${report.data.attempts}，耗时 ${report.data.durationMs}ms）events=${a.events} new_locations=${a.newLocations} new_npcs=${a.newNpcs} npc_updates=${a.npcUpdates} moves=${a.locationMoves} world_state=${a.worldState} phase_start=${a.phaseStarted} phase_end=${a.phaseEnded} time_advance=${a.timeAdvanced ? "是" : "否"}`,
		);
	} else {
		console.log(`✗ 失败（attempts=${report.data.attempts}）: ${truncate(report.data.error, 300)}`);
		console.log(`  本轮快照跳过，下轮将补齐（§6.1）`);
	}
	console.log(`--- 快照: ${report.snapshotTaken ? "已拍" : "跳过"} ---`);
	if (report.consecutiveDataFailures > 0) {
		console.log(`--- data 连续失败 ${report.consecutiveDataFailures} 轮，未落库内容将在下轮自动尝试补齐 ---`);
	}
}

async function cmdFork(arg: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime> {
	const { session, sessionManager, storyState } = runtime;
	const target = resolveTreeTarget(sessionManager, arg);
	// fork 截断点（SDK 语义）：user 目标 → 其 parentId（在目标输入前分叉重问）；assistant 目标 → 自身（clone 语义）。
	const truncateId = target.message.role === "user" ? (target.parentId ?? target.id) : target.id;
	const chain = buildAncestorChain(sessionManager.getEntries(), target.id);
	const oldSessionId = sessionManager.getSessionId();
	const oldStoryState = storyState;

	const newFile = sessionManager.createBranchedSession(truncateId);
	const newSessionId = sessionManager.getSessionId();
	const newStoryDir = join(ctx.storiesRoot, newSessionId);
	console.log(`> createBranchedSession → 新 sessionId=${newSessionId}（文件 ${newFile}）`);

	const forkResult = forkStoryDb(oldStoryState.snapshotsDb, chain, newStoryDir);
	console.log(
		`> forkStoryDb → 新故事目录 ${newStoryDir}（events=${forkResult.storyDb.reader.listEvents().length}，snapshots=${forkResult.snapshotsDb.listSnapshots().length} 份）`,
	);

	// 旧运行态收尾：dispose 旧 AgentSession + 关闭旧故事两库（新故事目录由 forkStoryDb 新建）。
	session.dispose();
	oldStoryState.storyDb.close();
	oldStoryState.snapshotsDb.close();

	const newStoryState: StoryState = {
		storyDir: newStoryDir,
		storyDb: forkResult.storyDb,
		snapshotsDb: forkResult.snapshotsDb,
	};
	const newRuntime = await createStoryRuntime({
		cwd: ctx.cwd,
		sessionManager,
		storyState: newStoryState,
		settings: ctx.settings,
		modelRuntime: ctx.modelRuntime,
		prompts: ctx.prompts,
		eventLog: createPipelineEventLog(join(newStoryDir, "pipeline-events.jsonl")),
		onWarning: (m) => console.warn(`[warn] ${m}`),
	});
	console.log(`> 已切换故事: ${oldSessionId} → ${newSessionId}`);
	return newRuntime;
}

async function runCommand(line: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime | undefined> {
	const [cmd, ...rest] = line.slice(1).split(/\s+/);
	const arg = rest.join(" ").trim();
	switch (cmd) {
		case "tree": {
			if (arg === "") {
				printTree(runtime.sessionManager);
				return undefined;
			}
			const target = resolveTreeTarget(runtime.sessionManager, arg);
			console.log(`> navigateTree(${target.id})（${target.message.role} 消息）`);
			const { session } = runtime;
			if (session.isStreaming) {
				console.log("> isStreaming 期间不能 navigateTree（须等上一轮完成）");
				return undefined;
			}
			await session.navigateTree(target.id);
			printRestoreResult(runtime.hooks.state.lastRestoreResult, runtime);
			return undefined;
		}
		case "fork": {
			if (arg === "") {
				console.log("用法: /fork <序号|entryId>");
				return undefined;
			}
			return cmdFork(arg, runtime, ctx);
		}
		case "status":
			printStatus(runtime);
			return undefined;
		case "help":
			printHelp();
			return undefined;
		default:
			console.log(`未知命令 /${cmd}（/help 查看）`);
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// 行队列（沿 m1-cli）
// ---------------------------------------------------------------------------

class LineQueue {
	private readonly lines: string[] = [];
	private readonly waiters: Array<(line: string) => void> = [];
	private eof = false;

	constructor(rl: Interface) {
		rl.on("line", (line) => {
			const waiter = this.waiters.shift();
			if (waiter) waiter(line);
			else this.lines.push(line);
		});
		rl.on("close", () => {
			this.eof = true;
			const waiter = this.waiters.shift();
			if (waiter) waiter("");
		});
	}

	async nextLine(prompt: string): Promise<string> {
		process.stdout.write(prompt);
		if (this.lines.length > 0) return this.lines.shift()!;
		if (this.eof) return "";
		return new Promise<string>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

// ---------------------------------------------------------------------------
// 启动与参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--root 缺少值");
			args.root = v;
		} else if (a === "--session-dir") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--session-dir 缺少值");
			args.sessionDir = v;
		} else if (a === "--resume") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--resume 缺少值");
			args.resume = v;
		} else {
			throw new Error(`未知参数: ${a}`);
		}
	}
	return args;
}

export async function main(argv: readonly string[]): Promise<void> {
	const args = parseArgs(argv);
	const storiesRoot = args.root ?? defaultStoriesRoot();
	const sessionDir = args.sessionDir ?? join(storiesRoot, "sessions");
	const cwd = repoRoot;

	let sessionManager: SessionManager;
	if (args.resume !== undefined) {
		sessionManager = SessionManager.open(args.resume);
	} else {
		sessionManager = SessionManager.create(cwd, sessionDir);
	}
	const sessionId = sessionManager.getSessionId();
	const dbPath = coreStoryDbPath(storiesRoot, sessionId);
	const storyState: StoryState = {
		storyDir: dirname(dbPath),
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};

	// 模型配置（§6.6）与提示词分层（§6.5）：全局层默认启用，包/故事层由后续卡包系统注入。
	const { settings, warnings: settingsWarnings } = loadSettings();
	const prompts: PromptLayerDirs = { globalDir: defaultGlobalPromptsDir() };
	// ModelRuntime 共享实例（并行纪律：多 subagent session 共享凭证/模型，技术路线 §3.2）。
	const modelRuntime = await ModelRuntime.create();
	const eventLog = createPipelineEventLog(join(storyState.storyDir, "pipeline-events.jsonl"));

	console.log(`> sessionId: ${sessionId}`);
	console.log(`> session file: ${sessionManager.getSessionFile()}`);
	console.log(`> storyDir: ${storyState.storyDir}`);
	for (const w of settingsWarnings) console.warn(`[warn] ${w}`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const queue = new LineQueue(rl);

	const ctx: CliCtx = { storiesRoot, cwd, settings, modelRuntime, prompts };

	let runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		settings,
		modelRuntime,
		prompts,
		eventLog,
		onWarning: (m) => console.warn(`[warn] ${m}`),
	});
	console.log(
		`> 工具白名单: [${runtime.session.getActiveToolNames().join(", ")}]（应为空：主叙事零 DB 工具，§6.0）`,
	);

	console.log("\n输入行动/对话开始叙事；斜杠命令见 /help；空行退出。");
	try {
		for (;;) {
			const line = (await queue.nextLine("> ")).trim();
			if (line === "") break;
			if (line.startsWith("/")) {
				const next = await runCommand(line, runtime, ctx);
				if (next !== undefined) runtime = next;
			} else {
				const report = await runtime.runTurn(line);
				printTurn(report);
			}
		}
	} finally {
		rl.close();
		runtime.dispose();
		runtime.storyState.storyDb.close();
		runtime.storyState.snapshotsDb.close();
		console.log(
			`> 故事目录保留（未删）: ${runtime.storyState.storyDir}\n> 可续写: node packages/app/src/m2-cli.ts --resume ${runtime.sessionManager.getSessionFile()}`,
		);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	});
}
