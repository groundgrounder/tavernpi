// M5 交互 CLI（人工验收入口，创作规划 §4 / §7-M5）：卡包（世界包）叙事循环。
//
// 与 m4-cli 的关系：命令/LineQueue/fork 重建全同，差异是卡包接线——
//   新故事经 createStory（§4.1：卡包加载校验 → SQL+条目 seed 迁移 → story.yaml 消费
//   （历法/粒度写 clock、开场白首轮 + turn_log 0 + 初始快照）→ story.meta.json）；
//   runtime 传 packs 选项（PackCache 注入热更 + pinned 手动钉 + 预算），
//   每轮 before_agent_start 经 {{collection_injection}} 注入检索命中条目（§4.1 M5 定稿）。
// 目的：验收 §4.0 契约——设定集加载与检索式注入（含引用校验、条目 seed DB）、
//   schema/seed 执行、多包共存（命名空间前缀）、story.yaml 消费。
// 命令增量：`--pack <dir>`（可重复）、`/packs`、`/pin` / `/unpin`、`/reload`。
//
// 坑（同 m4-cli）：session.prompt 必须 await 完才能 navigateTree；退出不删故事目录。
// TODO(M6)：多包提示词层——PromptLayerDirs.packDir 单目录，M5 取首包 prompts/；
//   包代码（extensionEntryPaths → additionalExtensionPaths）挂载点待 M6 模式设计。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	PackCache,
	buildAncestorChain,
	createPipelineEventLog,
	createStory,
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
	type StoryMetaFile,
	type StoryRuntime,
	type StoryState,
	type StylizeRuntimeOptions,
	type TavernSettings,
	type TurnResult,
	type WorldPack,
} from "@tavernpi/core";

// ---------------------------------------------------------------------------
// 常量与参数
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, "../../..");

interface CliArgs {
	root?: string;
	resume?: string;
	pack: string[];
	stylize?: boolean;
	style?: string;
}

interface CliCtx {
	storiesRoot: string;
	cwd: string;
	settings: TavernSettings;
	modelRuntime: ModelRuntime;
	prompts: PromptLayerDirs;
	stylize?: StylizeRuntimeOptions;
	/** 卡包注入（packDirs 为空 = undefined，M4 形态）。 */
	packs?: { cache: PackCache; pinned: () => string[] };
	/** 会话级手动钉列表（/pin /unpin 维护；经 getter 传入 runtime）。 */
	pinned: string[];
	/** 已加载包（/packs 展示；fork 重建复用 packDirs 重新建 cache）。 */
	packDirs: string[];
}

function runtimeExtras(ctx: CliCtx): {
	npc: { enabled: boolean };
	story: { enabled: boolean };
	stylize?: StylizeRuntimeOptions;
	packs?: { cache: PackCache; pinned: () => string[] };
} {
	return {
		npc: { enabled: true },
		story: { enabled: true },
		stylize: ctx.stylize,
		packs: ctx.packs,
	};
}

// ---------------------------------------------------------------------------
// 文本/转录工具（沿 m4-cli）
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
// 卡包命令辅助
// ---------------------------------------------------------------------------

function readStoryMeta(storyDir: string): StoryMetaFile | undefined {
	try {
		return JSON.parse(readFileSync(join(storyDir, "story.meta.json"), "utf8")) as StoryMetaFile;
	} catch {
		return undefined;
	}
}

function printPacks(packs: WorldPack[]): void {
	if (packs.length === 0) {
		console.log("--- packs: 无（M4 形态，无世界包注入） ---");
		return;
	}
	console.log("--- packs ---");
	for (const p of packs) {
		const byType = new Map<string, number>();
		for (const e of p.entries) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
		const typeSummary = [...byType.entries()].map(([t, n]) => `${t} ${n}`).join("、");
		console.log(
			`[${p.name}] ${p.dir}\n  条目 ${p.entries.length}（${typeSummary}）· ${p.hasCode ? "含代码（M5 不加载，M6 挂载）" : "纯内容包"}${p.story.title ? `\n  story.yaml: ${p.story.title}（${p.story.calendar ?? "默认历法"}/${p.story.granularity ?? "默认粒度"}）` : ""}`,
		);
	}
}

// ---------------------------------------------------------------------------
// CLI 命令（沿 m4-cli，增量 /packs /pin /unpin /reload）
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

function printStatus(runtime: StoryRuntime, ctx: CliCtx): void {
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
	console.log(`packs: ${ctx.packDirs.length > 0 ? ctx.packDirs.join(", ") : "（无）"} | pinned: ${ctx.pinned.length > 0 ? ctx.pinned.join(", ") : "（无）"}`);
}

function printHelp(): void {
	console.log(
		[
			"可用命令：",
			"  /tree              列出当前 branch 的消息条目",
			"  /tree <序号|entryId>  跳转到目标条目（钩子自动恢复 DB）",
			"  /fork <序号|entryId>  从目标条目分叉新故事（user 目标 = 其前分叉重问）",
			"  /status            打印 sessionId / clock / 行数 / packs / pinned",
			"  /packs             列出已加载世界包与条目统计",
			"  /pin <包名:type:id>   手动钉条目（每轮必注入，最高优先级）",
			"  /unpin <包名:type:id> 取消手动钉",
			"  /reload            重新加载卡包（mtime 检测；校验失败回退上次成功快照 + warning）",
			"  /help              本帮助",
			"  空行               退出（不删故事目录，可 --resume 续写）",
			"",
			"卡包（§4）：--pack <dir> 可重复；新故事经 createStory 校验+seed+story.yaml 消费；",
			"  检索式注入 = keys 触发 / always_on 常驻 / /pin 手动钉，预算 1500 tokens。",
			"story/npc/stylize/data 行为同 m4-cli（/help 见 m4）。事件流见 pipeline-events.jsonl。",
		].join("\n"),
	);
}

function printTurn(report: TurnResult): void {
	console.log(`\n========== 第 ${report.turnSeq} 轮 ==========`);
	console.log("--- 正文 ---");
	console.log(report.narrativeText);
	if (report.collection) {
		console.log(
			`--- 卡包注入（§4.1） ---\n命中: ${report.collection.injected.length > 0 ? report.collection.injected.join(", ") : "（无）"}${report.collection.warnings.length > 0 ? `\n警告: ${report.collection.warnings.join("；")}` : ""}`,
		);
	}
	if (report.npc) {
		const onstageIds = report.npc.onstageNpcIds;
		const offIds = report.npc.offscreenTriggeredIds;
		console.log(
			`--- npc 阶段（§6.2） ---\n在场预演: ${onstageIds.length} 个（${onstageIds.length > 0 ? onstageIds.join(", ") : "无"}）| 离线推演: ${offIds.length} 个`,
		);
	}
	if (report.story) {
		const s = report.story;
		console.log(
			`--- story 阶段（§6.3） ---\n场景卡: ${s.sceneFallback ? "fallback" : "ok"} | 硬冲突: ${s.hardConflicts.length} | 报疑: ${s.suspicions.length} | 重写: ${s.revisions} 次${s.releasedWithWarnings ? " | 超限放行" : ""}`,
		);
	}
	if (report.stylize) {
		console.log(
			`--- stylize（§6.4） ---\n${report.stylize.applied ? "✓ 已润色" : "✗ 回退原文"}${report.stylize.drift ? `，drift: ${report.stylize.drift.join("; ")}` : ""}`,
		);
	}
	console.log("--- data 落库（§6.1） ---");
	if (report.data.ok) {
		const a = report.data.applied;
		console.log(
			`✓ 成功（attempts=${report.data.attempts}）events=${a.events} new_npcs=${a.newNpcs} time_advance=${a.timeAdvanced ? "是" : "否"}${report.data.dropped ? `，strictDrop 剔除 ${report.data.dropped.length} 项` : ""}`,
		);
	} else {
		console.log(`✗ 失败（attempts=${report.data.attempts}）: ${truncate(report.data.error, 300)}`);
	}
	console.log(`--- 快照: ${report.snapshotTaken ? "已拍" : "跳过"} ---`);
}

async function cmdFork(arg: string, runtime: StoryRuntime, ctx: CliCtx): Promise<StoryRuntime> {
	const { session, sessionManager, storyState } = runtime;
	const target = resolveTreeTarget(sessionManager, arg);
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

	session.dispose();
	oldStoryState.storyDb.close();
	oldStoryState.snapshotsDb.close();

	// fork 产物继承卡包绑定：复制 story.meta.json 到新故事目录（包路径不变）。
	const meta = readStoryMeta(oldStoryState.storyDir);
	if (meta !== undefined) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(newStoryDir, "story.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
	}
	// fork 重建 cache（注入热更按当前磁盘包内容）。
	if (ctx.packDirs.length > 0) ctx.packs = { cache: new PackCache(ctx.packDirs), pinned: () => ctx.pinned };

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
		...runtimeExtras(ctx),
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
			printStatus(runtime, ctx);
			return undefined;
		case "packs": {
			if (ctx.packs === undefined) {
				printPacks([]);
			} else {
				const { packs, warnings } = ctx.packs.cache.getPacks();
				printPacks(packs);
				for (const w of warnings) console.warn(`[warn] ${w}`);
			}
			return undefined;
		}
		case "pin": {
			if (arg === "") {
				console.log("用法: /pin <包名:type:id>");
				return undefined;
			}
			if (!ctx.pinned.includes(arg)) ctx.pinned.push(arg);
			console.log(`> pinned: [${ctx.pinned.join(", ")}]`);
			return undefined;
		}
		case "unpin": {
			const idx = ctx.pinned.indexOf(arg);
			if (idx >= 0) ctx.pinned.splice(idx, 1);
			console.log(`> pinned: [${ctx.pinned.join(", ")}]`);
			return undefined;
		}
		case "reload": {
			if (ctx.packs === undefined) {
				console.log("> 无卡包");
				return undefined;
			}
			const { packs, warnings } = ctx.packs.cache.getPacks();
			console.log(`> 已重载: ${packs.map((p) => `${p.name}(${p.entries.length} 条目)`).join(", ")}`);
			for (const w of warnings) console.warn(`[warn] ${w}`);
			return undefined;
		}
		case "help":
			printHelp();
			return undefined;
		default:
			console.log(`未知命令 /${cmd}（/help 查看）`);
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// 行队列（沿 m4-cli）
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
	const args: CliArgs = { pack: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--root 缺少值");
			args.root = v;
		} else if (a === "--resume") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--resume 缺少值");
			args.resume = v;
		} else if (a === "--pack") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--pack 缺少值");
			args.pack.push(v);
		} else if (a === "--stylize") {
			args.stylize = true;
		} else if (a === "--style") {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error("--style 缺少值");
			args.style = v;
			args.stylize = true;
		} else {
			throw new Error(`未知参数: ${a}`);
		}
	}
	return args;
}

export async function main(argv: readonly string[]): Promise<void> {
	const args = parseArgs(argv);
	const storiesRoot = args.root ?? defaultStoriesRoot();
	const cwd = repoRoot;

	let sessionManager: SessionManager;
	let storyState: StoryState;
	let packDirs = args.pack.map((d) => resolve(d));

	if (args.resume !== undefined) {
		// 续写：session 文件恢复；packDirs 从 story.meta.json 恢复（命令行 --pack 可覆盖补充）。
		sessionManager = SessionManager.open(args.resume);
		const sessionId = sessionManager.getSessionId();
		const dbPath = coreStoryDbPath(storiesRoot, sessionId);
		storyState = {
			storyDir: join(storiesRoot, sessionId),
			storyDb: openStoryDb(dbPath),
			snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
		};
		const meta = readStoryMeta(storyState.storyDir);
		if (packDirs.length === 0 && meta !== undefined) {
			packDirs = meta.packs.map((p) => p.dir);
			if (packDirs.length > 0) console.log(`> 从 story.meta.json 恢复卡包: ${meta.packs.map((p) => p.name).join(", ")}`);
		}
	} else {
		// 新故事：createStory（卡包校验 → SQL+seed 迁移 → story.yaml 消费 → 开场白首轮 → 元数据）
		const created = await createStory({ storiesRoot, packDirs, cwd });
		sessionManager = created.sessionManager;
		storyState = created.storyState;
		if (created.packs.length > 0) {
			printPacks(created.packs);
			const clock = storyState.storyDb.reader.getClock();
			console.log(`> clock 初值: ${clock?.current_time}（${clock?.calendar}/${clock?.granularity}）`);
		}
	}
	const sessionId = sessionManager.getSessionId();

	// 模型配置（§6.6）与提示词分层（§6.5）：全局层 + 首包 prompts/ 层（多包提示词层 M6）。
	const { settings, warnings: settingsWarnings } = loadSettings();
	const prompts: PromptLayerDirs = {
		globalDir: defaultGlobalPromptsDir(),
		...(packDirs.length > 0 ? { packDir: packDirs[0] } : {}),
	};
	const modelRuntime = await ModelRuntime.create();
	const eventLog = createPipelineEventLog(join(storyState.storyDir, "pipeline-events.jsonl"));

	console.log(`> sessionId: ${sessionId}`);
	console.log(`> session file: ${sessionManager.getSessionFile()}`);
	console.log(`> storyDir: ${storyState.storyDir}`);
	if (args.stylize) {
		console.log(`> stylize: 开启${args.style ? `（style=${args.style}）` : "（默认文风；story.meta.json defaultStyle 缺省供给）"}`);
	}
	for (const w of settingsWarnings) console.warn(`[warn] ${w}`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const queue = new LineQueue(rl);

	const pinned: string[] = [];
	const ctx: CliCtx = {
		storiesRoot,
		cwd,
		settings,
		modelRuntime,
		prompts,
		stylize: args.stylize ? { enabled: true, ...(args.style ? { styleHint: args.style } : {}) } : undefined,
		pinned,
		packDirs,
	};
	if (packDirs.length > 0) {
		ctx.packs = { cache: new PackCache(packDirs), pinned: () => ctx.pinned };
	}

	let runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		settings,
		modelRuntime,
		prompts,
		eventLog,
		onWarning: (m) => console.warn(`[warn] ${m}`),
		...runtimeExtras(ctx),
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
			`> 故事目录保留（未删）: ${runtime.storyState.storyDir}\n> 可续写: node packages/app/src/m5-cli.ts --resume ${runtime.sessionManager.getSessionFile()}`,
		);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	});
}
