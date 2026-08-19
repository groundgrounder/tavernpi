// M1 交互 CLI（人工验收入口，创作规划 §7-M1）：单 agent 叙事循环 + 持久化与快照接线。
//
// 目的：验证 §3.0 契约——/tree 回溯后 DB 与时钟一致、回溯后再前进、fork 后新故事 DB 独立。
// 接线（Lane 3，app 层只消费 core API）：
//   SessionManager（pi session 树，JSONL 持久化）
//     ↔ StoryDb（story.db，openStoryDb + turn_seq 纪律写者）
//     ↔ SnapshotsDb（snapshots.db，takeSnapshot/findNearestSnapshot）
//     ↔ createSnapshotHooks（挂 session_before_tree / session_tree，导航即原子恢复）
//     ↔ createDbTools（get_clock/query_events/get_npc/write_event/advance_clock 白名单）
//     ↔ InteractionBroker（§6.7 轮中交互：readline handler + combat_check 演示工具，仅交互模式注册）。
//
// 关键接线决策：
// 1. 快照绑定本轮结束时的 leaf（最终 assistant entry），与 turn_log 同一 id。pi navigateTree
//    语义（v0.84.2 已核实）：导航目标为 user 消息 u_N 时 newLeaf = u_N.parentId = a_{N-1}，
//    意图是重做第 N 轮，一致的世界状态 = 第 N-1 轮结束后——user-entry 绑定会恢复出「第 N 轮
//    结束后」，重做时事件会双重落库。assistant-leaf 绑定下：导航 u_N → 祖先链 [u_N, a_{N-1}, …]
//    命中 a_{N-1} 快照（第 N-1 轮末）✓；导航 a_N → 命中自身快照（第 N 轮末）✓；导航 u_1（首个
//    user）→ 链上无快照 → 空库兜底 = 故事初始态 ✓。
// 2. 写工具经 getter 命中「当前」storyDb（core createDbTools 支持 StoryDb | (() => StoryDb)）——
//    恢复会以新 StoryDb 实例原子替换（restore.ts 取舍），getter 保证工具链在恢复后仍有效，
//    无需重建会话/工具。
// 3. fork 流程：createBranchedSession（原地切 SM 到新 session，新 id/新文件）→ dispose 旧
//    AgentSession → forkStoryDb（旧 snapshots.db 祖先链最近快照 → 新故事目录）→ 同一 SM 重建
//    createAgentSession（新 loader/工具/钩子，绑定新故事目录）。
// 4. turnSeq 由 CLI 持有计数器：每轮从 reader 现有最大 turn_seq（turn_log）续 +1，经
//    createDbTools 的 getCurrentTurnSeq 注入，模型不接触（core tools.ts fail-loud 兜底）。
//
// 坑：
// - session.prompt 必须 await 完（isStreaming=false）才能 navigateTree（spike/05 实证）。
// - 退出不删故事目录——人工验收要可重复进入（--resume 会话文件）。
// - 恢复（restore）用新 StoryDb 实例替换，旧连接被关闭；任何长期持有 storyDb 的闭包
//   （除 createDbTools 的 getter）都会在恢复后读到已关闭连接。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	buildAncestorChain,
	createDbTools,
	createSnapshotHooks,
	defaultStoriesRoot,
	forkStoryDb,
	InteractionBroker,
	InteractionUnavailableError,
	judgeCombat,
	openSnapshotsDb,
	openStoryDb,
	snapshotsDbPath,
	storyDbPath as coreStoryDbPath,
	takeSnapshot,
	type InteractionRequest,
	type SnapshotHooks,
	type SnapshotRestoreResult,
	type SnapshotsDb,
	type StoryClock,
	type StoryDb,
} from "@tavernpi/core";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const repoRoot = resolve(import.meta.dirname, "../../..");
const narratorContent = readFileSync(resolve(repoRoot, "packages/core/prompts/narrator.md"), "utf-8");

/** db 工具白名单（与 createDbTools 返回的工具名一一对应）。 */
const DB_TOOL_NAMES = ["get_clock", "query_events", "get_npc", "write_event", "advance_clock"] as const;

/** 系统提示附加约定：强引导模型每轮调用 write_event 与 advance_clock（M1 验收依赖）。 */
const M1_APPEND = [
	"（M1 约定，务必遵守）每轮都必须至少各调用一次以下工具：",
	"1. write_event(summary, detail)：把本轮最重要的叙事事件落库，summary 用一句话摘要。",
	"2. advance_clock(to_time, span_note)：推进故事时间。to_time 用形如 0001-01-02 的日期字符串，必须比当前故事时间更晚；span_note 说明时间跨度。",
	"正文保持 2-6 段叙事散文，不与已落库的事实矛盾。",
];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 可变故事状态容器：恢复会替换 storyDb 实例（hooks.setStoryDb），目录不变。 */
export interface M1StoryState {
	storyDir: string;
	storyDb: StoryDb;
	snapshotsDb: SnapshotsDb;
}

/** 单轮叙事结果（turn_log + 快照已落库）。 */
export interface TurnReport {
	turnSeq: number;
	/** 本轮 user entry id（导航到「重做该轮输入」时的目标）。 */
	userEntryId: string;
	/** 本轮 assistant leaf id（turn_log 与快照绑定键）。 */
	leafId: string;
	narrativeText: string;
	toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
	eventsBefore: Array<{ id: number; turn_seq: number; summary: string }>;
	eventsAfter: Array<{ id: number; turn_seq: number; summary: string }>;
	clockAfter: StoryClock | undefined;
	snapshotRowCount: number;
}

export interface M1RuntimeOptions {
	cwd: string;
	sessionManager: SessionManager;
	storyState: M1StoryState;
	onWarning?: (message: string) => void;
	/**
	 * 轮中交互（§6.7）：传 InteractionBroker 则注册 combat_check 演示工具并加入白名单。
	 * 脚本/验收模式（m1:accept）缺省不传——白名单保持既有 5 工具，验收 30 项断言不受影响。
	 */
	interaction?: InteractionBroker;
}

/** 一次完整接线运行态（fork 后重建新实例）。 */
export interface M1Runtime {
	session: AgentSession;
	sessionManager: SessionManager;
	storyState: M1StoryState;
	hooks: SnapshotHooks;
	getTurnSeq(): number;
	setTurnSeq(v: number): void;
	dispose(): void;
}

interface CliArgs {
	root?: string;
	sessionDir?: string;
	resume?: string;
}

// ---------------------------------------------------------------------------
// 文本/转录工具（沿 M0 demo 与 spike/05）
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

function scanToolCalls(messages: ReadonlyArray<{ role: string; content?: unknown }>): Array<{ name: string; arguments: Record<string, unknown> }> {
	const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const item of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
			if (item.type === "toolCall") {
				calls.push({
					name: item.name ?? "?",
					arguments: (item.arguments ?? {}) as Record<string, unknown>,
				});
			}
		}
	}
	return calls;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 当前最大 turn_seq 的下一轮（turn_log 每轮一行，PK 保证完整性；新库为 1）。 */
export function computeNextTurnSeq(storyDb: StoryDb): number {
	const logs = storyDb.reader.getTurnLog();
	const last = logs.at(-1);
	return last ? last.turn_seq + 1 : 1;
}

/** 本轮 user entry id = prompt 前 leaf 的新 user 子条目（正常 prompt 流恒成立）；供导航「重做该轮」定位。 */
function getUserEntryId(sessionManager: SessionManager, beforeLeaf: string | null): string {
	const newUser = sessionManager.getEntries().find(
		(e) => e.type === "message" && e.message.role === "user" && e.parentId === beforeLeaf,
	);
	if (!newUser) {
		throw new Error(`prompt 后未找到新 user entry（beforeLeaf=${beforeLeaf}）——快照绑定失败`);
	}
	return newUser.id;
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

// ---------------------------------------------------------------------------
// 运行时构建 / 单轮 / 导航（供 CLI 与验收脚本共用）
// ---------------------------------------------------------------------------

/**
 * 构建一次完整接线运行态：hooks + resource loader（narrator + M1 约定）+ db 工具 + agent session。
 * 写工具经 getter 代理命中「当前」storyDb（恢复替换实例后仍然有效）。
 */
export async function buildM1Runtime(options: M1RuntimeOptions): Promise<M1Runtime> {
	const { cwd, sessionManager, storyState, onWarning, interaction } = options;
	let turnSeq = computeNextTurnSeq(storyState.storyDb);

	const hooks = createSnapshotHooks({
		snapshotsDb: storyState.snapshotsDb,
		getStoryDb: () => storyState.storyDb,
		setStoryDb: (db) => {
			storyState.storyDb = db;
		},
		getEntryAncestors: (entryId) => buildAncestorChain(sessionManager.getEntries(), entryId),
		onWarning,
	});

	const extensionFactories: Array<(pi: ExtensionAPI) => void> = [
		(pi) => {
			pi.on("session_before_tree", (event, ctx) => {
				hooks.sessionBeforeTree(event, ctx);
			});
			pi.on("session_tree", (event, ctx) => {
				hooks.sessionTree(event, ctx);
			});
		},
	];

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
		appendSystemPromptOverride: () => M1_APPEND,
		extensionFactories,
	});
	await loader.reload();

	// 写工具经 getter 命中「当前」storyDb（core createDbTools 支持 StoryDb | (() => StoryDb)）：
	// 恢复会用新 StoryDb 实例原子替换，getter 保证工具链在恢复后仍然有效，无需重建会话。
	const customTools = createDbTools(() => storyState.storyDb, { getCurrentTurnSeq: () => turnSeq });
	const toolNames: string[] = [...DB_TOOL_NAMES];
	// 轮中交互（§6.7）：仅交互模式注册 combat_check（验收脚本共享本构建块，但白名单保持在 5 工具）。
	if (interaction !== undefined) {
		customTools.push(createCombatCheckTool(interaction));
		toolNames.push("combat_check");
	}

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd,
		sessionManager,
		resourceLoader: loader,
		customTools,
		tools: toolNames,
	});
	if (modelFallbackMessage) {
		console.warn(`[warn] ${modelFallbackMessage}`);
	}

	return {
		session,
		sessionManager,
		storyState,
		hooks,
		getTurnSeq: () => turnSeq,
		setTurnSeq: (v: number) => {
			turnSeq = v;
		},
		dispose: () => {
			session.dispose();
		},
	};
}

/** 跑一轮叙事：取 turnSeq → prompt → turn_log(assistant leaf) → 快照(assistant leaf) → 报告。 */
export async function runM1Turn(runtime: M1Runtime, input: string): Promise<TurnReport> {
	const { session, sessionManager, storyState } = runtime;
	if (session.isStreaming) {
		throw new Error("isStreaming 期间不能 prompt（应等待上一轮完成）");
	}
	const beforeCount = session.state.messages.length;
	const beforeLeaf = sessionManager.getLeafId();
	const eventsBefore = storyState.storyDb.reader.listEvents();

	const turnSeq = computeNextTurnSeq(storyState.storyDb);
	runtime.setTurnSeq(turnSeq);

	await session.prompt(input);

	const leafId = sessionManager.getLeafId();
	if (leafId === null) {
		throw new Error("prompt 后无 leaf entry（会话树异常）");
	}
	const userEntryId = getUserEntryId(sessionManager, beforeLeaf);
	const newMessages = session.state.messages.slice(beforeCount);
	const toolCalls = scanToolCalls(newMessages);
	const narrativeText = extractLastAssistantReply(newMessages) ?? "";

	// turn_log 与快照都绑定本轮 leaf（最终 assistant entry）：导航到 user u_N 重做第 N 轮时
	// 恢复第 N-1 轮末状态，保证一致性且防止事件双重落库（见文件头决策 1）。
	storyState.storyDb.writer.recordTurnLog({
		turnSeq,
		sessionEntryId: leafId,
		userInput: input,
		narrativeText,
	});
	const snapshot = await takeSnapshot(storyState.storyDb, { turnSeq, sessionEntryId: leafId });

	const eventsAfter = storyState.storyDb.reader.listEvents();
	const clockAfter = storyState.storyDb.reader.getClock();
	return {
		turnSeq,
		userEntryId,
		leafId,
		narrativeText,
		toolCalls,
		eventsBefore,
		eventsAfter,
		clockAfter,
		snapshotRowCount: snapshot.rowCount,
	};
}

/** navigateTree + 钩子自动恢复；返回钩子的恢复结果（调用方据 lastRestoreResult 核对）。 */
export async function navigateToEntry(runtime: M1Runtime, targetId: string): Promise<SnapshotRestoreResult | undefined> {
	const { session } = runtime;
	if (session.isStreaming) {
		throw new Error("isStreaming 期间不能 navigateTree（须等上一轮 prompt 完成，spike/05 语义）");
	}
	await session.navigateTree(targetId);
	return runtime.hooks.state.lastRestoreResult;
}

// ---------------------------------------------------------------------------
// 轮中交互（§6.7）：combat_check 演示工具 + readline handler
// ---------------------------------------------------------------------------

/**
 * 行队列读取器：用 node:readline 的 'line' 事件把 stdin 逐行入队，读取侧按需取。
 * 选型原因：readline/promises 的 question() 在 stdin EOF 时立即抛 ERR_USE_AFTER_CLOSE
 * （'close' 在流结束后立刻触发，缓冲行会丢失）——脚本化管道输入（printf 喂多行）不可靠。
 * 而 'line' 事件在 EOF 前对所有缓冲行都会触发：先入队，读取侧再按序消费，天然确定。
 */
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
			if (waiter) waiter(""); // EOF 哨兵：让等待方以空行退出/失败
		});
	}

	/** 取下一行（打印 prompt 后等待；EOF 后返回空串）。 */
	async nextLine(prompt: string): Promise<string> {
		process.stdout.write(prompt);
		if (this.lines.length > 0) return this.lines.shift()!;
		if (this.eof) return "";
		return new Promise<string>((resolve) => {
			this.waiters.push(resolve);
		});
	}
}

const COMBAT_OPTIONS = ["稳扎稳打", "冒险突进", "伺机闪避"] as const;

/**
 * combat_check 演示工具：发起一次 choice + 一次 confirm 轮中交互，按确定性规则
 * （core judgeCombat）算出 success/partial/failure 与叙事提示。交互不可用（无 UI handler）
 * 时按默认谨慎分支降级（§6.7 降级契约），不崩溃。
 */
function createCombatCheckTool(broker: InteractionBroker): ToolDefinition {
	const choiceSchema = Type.Object({ option: Type.Integer({ description: "选中项序号（0 基）" }) });
	const confirmSchema = Type.Object({ confirmed: Type.Boolean() });
	return defineTool({
		name: "combat_check",
		label: "战斗判定",
		description:
			"战斗/危险行动需要判定时调用：向玩家发起行动方式选择与全力一搏确认的轮中交互，按判定规则返回 success/partial/failure 与叙事提示文本。交互不可用（无 UI handler）时自动按默认谨慎分支降级。",
		parameters: Type.Object(
			{
				action: Type.String({ description: "行动描述" }),
				difficulty: Type.Union(
					[Type.Literal("easy"), Type.Literal("normal"), Type.Literal("hard")],
					{ description: "难度：easy/normal/hard" },
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const base = { action: params.action, difficulty: params.difficulty };
			try {
				const choice = await broker.request({
					kind: "choice",
					prompt: `战斗判定「${params.action}」（难度 ${params.difficulty}）：选择行动方式`,
					payload: { options: [...COMBAT_OPTIONS] },
					responseSchema: choiceSchema,
					timeoutMs: 120_000,
				});
				const confirm = await broker.request({
					kind: "confirm",
					prompt: "是否全力一搏？",
					responseSchema: confirmSchema,
					timeoutMs: 120_000,
				});
				const judgement = judgeCombat({
					difficulty: params.difficulty,
					choiceOption: choice.option,
					allIn: confirm.confirmed,
				});
				const optionName = COMBAT_OPTIONS[choice.option] ?? "?";
				const allInText = confirm.confirmed ? "，并全力一搏" : "";
				return {
					content: [
						{
							type: "text",
							text: `战斗判定结果: ${judgement.outcome}（选择「${optionName}」${allInText}，得分 ${judgement.score}）——${judgement.hint}`,
						},
					],
					details: {
						...base,
						choiceOption: choice.option,
						allIn: confirm.confirmed,
						...judgement,
						degraded: false,
					},
				};
			} catch (err) {
				if (err instanceof InteractionUnavailableError) {
					// 降级契约（§6.7）：无 UI handler 时按默认谨慎分支返回，不崩溃、不挂死。
					const judgement = judgeCombat({ difficulty: params.difficulty, choiceOption: 0, allIn: false });
					return {
						content: [
							{
								type: "text",
								text: `（交互不可用，按默认谨慎分支降级）战斗判定结果: ${judgement.outcome}（稳扎稳打，得分 ${judgement.score}）——${judgement.hint}`,
							},
						],
						details: { ...base, choiceOption: 0, allIn: false, ...judgement, degraded: true },
					};
				}
				throw err;
			}
		},
	});
}

/** readline 交互 handler（三种内置 kind；未知 kind 抛错，让工具降级路径可见）。 */
async function readlineInteractionHandler(req: InteractionRequest, queue: LineQueue): Promise<unknown> {
	switch (req.kind) {
		case "confirm": {
			const answer = (await queue.nextLine(`${req.prompt}（y/n）> `)).trim().toLowerCase();
			if (answer === "y" || answer === "yes") return { confirmed: true };
			if (answer === "n" || answer === "no") return { confirmed: false };
			throw new Error(`非法确认输入: ${JSON.stringify(answer)}（应为 y/n）`);
		}
		case "choice": {
			const options = ((req.payload ?? {}) as { options?: unknown }).options;
			if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
				throw new Error("choice 交互缺合法 payload.options（string[]）");
			}
			console.log(req.prompt);
			options.forEach((opt, i) => console.log(`  [${i + 1}] ${opt}`));
			const line = (await queue.nextLine("> ")).trim();
			const idx = Number(line) - 1;
			if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
				throw new Error(`非法选项序号: ${JSON.stringify(line)}（应为 1-${options.length}）`);
			}
			return { option: idx };
		}
		case "text": {
			const line = (await queue.nextLine(`${req.prompt}> `)).trim();
			return { text: line };
		}
		default:
			throw new Error(`未知交互 kind: ${req.kind}（内置 confirm/choice/text；卡包自定义 包名:kind）`);
	}
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

function printRestoreResult(result: SnapshotRestoreResult | undefined, runtime: M1Runtime): void {
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

function printStatus(runtime: M1Runtime): void {
	const { sessionManager, storyState } = runtime;
	const clock = storyState.storyDb.reader.getClock();
	const events = storyState.storyDb.reader.listEvents();
	const turns = storyState.storyDb.reader.getTurnLog();
	const snaps = storyState.snapshotsDb.listSnapshots();
	console.log("--- status ---");
	console.log(`sessionId: ${sessionManager.getSessionId()}`);
	console.log(`sessionFile: ${sessionManager.getSessionFile()}`);
	console.log(`leafId: ${sessionManager.getLeafId()}`);
	console.log(`storyDir: ${storyState.storyDir}`);
	console.log(`clock: ${clock ? `${clock.current_time}（${clock.calendar}/${clock.granularity}）` : "(未初始化)"}`);
	console.log(`events: ${events.length} 行 | turn_log: ${turns.length} 行 | snapshots: ${snaps.length} 份`);
}

function printHelp(): void {
	console.log(
		[
			"可用命令：",
			"  /tree              列出当前 branch 的消息条目（序号 + role + 摘要 + entry id 前 8 位）",
			"  /tree <序号|entryId>  跳转到目标条目（user 目标 → 重做该轮，恢复其前一轮末状态；assistant 目标 → 该轮末状态），钩子自动恢复 DB",
			"  /fork <序号|entryId>  从目标条目分叉新故事（user 目标 = 其前分叉重问）",
			"  /status             打印 sessionId / leafId / clock / 行数",
			"  /help               本帮助",
			"  空行                退出（不删故事目录，可 --resume 续写）",
			"",
			"轮中交互（§6.7）：模型发起战斗/危险判定时调用 combat_check，会在终端向你提问",
			"（选择行动方式 + 是否全力一搏）；输入对应序号与 y/n 即可，判定结果进入本轮叙事。",
		].join("\n"),
	);
}

function printTurn(report: TurnReport): void {
	console.log(`\n========== 第 ${report.turnSeq} 轮 ==========`);
	console.log("--- 正文 ---");
	console.log(report.narrativeText);
	const added = report.eventsAfter.slice(report.eventsBefore.length);
	console.log("--- 本轮 DB 变更 ---");
	if (added.length === 0) console.log("(无新事件)");
	for (const e of added) console.log(`+ events#${e.id} turn${e.turn_seq}: ${e.summary}`);
	console.log(`--- clock: ${report.clockAfter ? report.clockAfter.current_time : "(未推进)"} ---`);
	console.log(
		`--- 工具: ${report.toolCalls.length === 0 ? "(无)" : report.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(" ")} ---`,
	);
	console.log(`--- 快照: 已拍（turn_seq=${report.turnSeq}，snapshots.db 共 ${report.snapshotRowCount} 份） ---`);
}

async function cmdFork(arg: string, runtime: M1Runtime, storiesRoot: string, cwd: string): Promise<M1Runtime> {
	const { session, sessionManager, storyState } = runtime;
	const target = resolveTreeTarget(sessionManager, arg);
	// fork 截断点（SDK 语义）：user 目标 → 其 parentId（在目标输入前分叉重问）；assistant 目标 → 自身（clone 语义）。
	const truncateId = target.message.role === "user" ? (target.parentId ?? target.id) : target.id;
	const chain = buildAncestorChain(sessionManager.getEntries(), target.id);
	const oldSessionId = sessionManager.getSessionId();
	const oldStoryState = storyState;

	const newFile = sessionManager.createBranchedSession(truncateId);
	const newSessionId = sessionManager.getSessionId();
	const newStoryDir = join(storiesRoot, newSessionId);
	console.log(`> createBranchedSession → 新 sessionId=${newSessionId}（文件 ${newFile}）`);

	const forkResult = forkStoryDb(oldStoryState.snapshotsDb, chain, newStoryDir);
	console.log(
		`> forkStoryDb → 新故事目录 ${newStoryDir}（events=${forkResult.storyDb.reader.listEvents().length}，snapshots=${forkResult.snapshotsDb.listSnapshots().length} 份）`,
	);

	// 旧运行态收尾：dispose 旧 AgentSession + 关闭旧故事两库（新故事目录由 forkStoryDb 新建）。
	session.dispose();
	oldStoryState.storyDb.close();
	oldStoryState.snapshotsDb.close();

	const newStoryState: M1StoryState = {
		storyDir: newStoryDir,
		storyDb: forkResult.storyDb,
		snapshotsDb: forkResult.snapshotsDb,
	};
	const newRuntime = await buildM1Runtime({
		cwd,
		sessionManager,
		storyState: newStoryState,
		onWarning: (m) => console.warn(`[warn] ${m}`),
	});
	console.log(`> 已切换故事: ${oldSessionId} → ${newSessionId}`);
	return newRuntime;
}

async function runCommand(
	line: string,
	runtime: M1Runtime,
	ctx: { storiesRoot: string; cwd: string },
): Promise<M1Runtime | undefined> {
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
			const result = await navigateToEntry(runtime, target.id);
			printRestoreResult(result, runtime);
			return undefined;
		}
		case "fork": {
			if (arg === "") {
				console.log("用法: /fork <序号|entryId>");
				return undefined;
			}
			return cmdFork(arg, runtime, ctx.storiesRoot, ctx.cwd);
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
	const storyState: M1StoryState = {
		storyDir: dirname(dbPath),
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};

	console.log(`> sessionId: ${sessionId}`);
	console.log(`> session file: ${sessionManager.getSessionFile()}`);
	console.log(`> storyDir: ${storyState.storyDir}`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const queue = new LineQueue(rl);

	// 轮中交互（§6.7）：注册 readline handler（confirm/choice/text），演示工具 combat_check
	// 仅交互模式注册（验收脚本缺省不传 interaction，白名单保持 5 工具）。
	const broker = new InteractionBroker();
	broker.registerHandler((req) => readlineInteractionHandler(req, queue));

	let runtime = await buildM1Runtime({
		cwd,
		sessionManager,
		storyState,
		onWarning: (m) => console.warn(`[warn] ${m}`),
		interaction: broker,
	});
	console.log(`> 工具白名单: [${runtime.session.getActiveToolNames().join(", ")}]`);

	console.log("\n输入行动/对话开始叙事；斜杠命令见 /help；空行退出。");
	try {
		for (;;) {
			const line = (await queue.nextLine("> ")).trim();
			if (line === "") break;
			if (line.startsWith("/")) {
				const next = await runCommand(line, runtime, { storiesRoot, cwd });
				if (next !== undefined) runtime = next;
			} else {
				const report = await runM1Turn(runtime, line);
				printTurn(report);
			}
		}
	} finally {
		rl.close();
		runtime.dispose();
		runtime.storyState.storyDb.close();
		runtime.storyState.snapshotsDb.close();
		console.log(
			`> 故事目录保留（未删）: ${runtime.storyState.storyDir}\n> 可续写: node packages/app/src/m1-cli.ts --resume ${runtime.sessionManager.getSessionFile()}`,
		);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exitCode = 1;
	});
}
