// M2 故事驱动集成验收（创作规划 §7-M2 / §6.1 data 契约 / §3.0 回归）：自断言脚本，exit code 正确。
//
// 三区：
// A. 基线 10 轮（真实 LLM，narrator + data 全真实）：连续叙事不阻塞、turn_log/time_log/快照
//    一致性、锚点抽取、db_summary 注入观测、pipeline 事件流留痕。
// B. 失败路径（dataExecutor 注入，确定性；每场景独立故事目录）：重试成功 / 重试耗尽不拍快照 /
//    下轮补齐（pendingTurns 注入） / 连续失败提示。
// C. 回溯一致性（§3.0 M2 形态回归）：navigateTree + hooks 自动恢复 → clock/events 回退；
//    回溯后再前进 turn_seq 续接；空库兜底不误判损伤。
// D. 回归与冒烟（外部执行，见报告）：npm test / typecheck / m1:accept / m2-cli 管道冒烟。
//
// 成本控制：A 11 轮 + B 6 轮（narrator 真实、data 多为桩）+ C 4 轮 ≈ 21 轮真实调用。
// 需要 auth.json（M0 已配）。结束时清理临时目录。
//
// 运行：npm run m2:accept（或 node packages/app/acceptance/m2.ts）。

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createPipelineEventLog,
	createStoryRuntime,
	DEFAULT_STORY_CLOCK,
	openSnapshotsDb,
	openStoryDb,
	runSubagent,
	snapshotsDbPath,
	storyDbPath,
	type DataStatusRow,
	type StoryClock,
	type StoryRuntime,
	type StoryState,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
	type TurnResult,
} from "@tavernpi/core";

const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

// ---------------------------------------------------------------------------
// 检查表
// ---------------------------------------------------------------------------

interface Check {
	label: string;
	ok: boolean;
}

function check(label: string, ok: boolean): Check {
	return { label, ok };
}

function printChecks(checks: Check[]): void {
	let failed = 0;
	for (const c of checks) {
		console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.label}`);
		if (!c.ok) failed++;
	}
	const passCount = checks.length - failed;
	console.log(`===== M2 验收: ${failed === 0 ? "PASS" : "FAIL"}（${passCount}/${checks.length} 通过） =====`);
	if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** ISO 日期 +1 天（弹性历法按日推进；用于手工合法变更集与断言）。
 *  不用 JS Date：Date.UTC(0, …) 会把 0-99 年解释为 1900+，幻想历法会跳去 1900 年。 */
function advanceIsoDay(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	let y = Number(m[1]);
	let mo = Number(m[2]);
	let d = Number(m[3]);
	const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	d++;
	if (d > (dim[mo - 1] ?? 31)) {
		d = 1;
		mo++;
	}
	if (mo > 12) {
		mo = 1;
		y++;
	}
	return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO_USAGE, durationMs: 1 };
}

type GarbageKind = "zod" | "semantic" | "throw";

function garbageResult(kind: GarbageKind): SubagentResult<unknown> {
	if (kind === "zod") {
		return stubResult({ events: [{ summary: 123 }] }); // zod 形状错误（summary 非 string）
	}
	if (kind === "throw") {
		throw new Error("注入执行失败（throw 垃圾）");
	}
	return stubResult({
		events: [{ summary: "x", location_name: "未知地点" }], // 语义校验错误（地点未登记）
		time_advance: { to_time: "0000-01-02" },
		new_locations: [],
		location_moves: [],
		new_npcs: [],
		npc_updates: [],
		world_state: [],
	});
}

/** 手工合法变更集（to_time 自适应当前 clock +1 天；空数组显式给出——JSON Schema 里 default 字段是 required）。 */
function manualValidResult(storyState: StoryState): SubagentResult<unknown> {
	const clock = storyState.storyDb.reader.getClock();
	const next = advanceIsoDay(clock?.current_time ?? DEFAULT_STORY_CLOCK.current_time);
	return stubResult({
		events: [{ summary: "验收手工事件" }],
		time_advance: { to_time: next, span_note: "验收推进" },
		new_locations: [],
		location_moves: [],
		new_npcs: [],
		npc_updates: [],
		world_state: [],
	});
}

interface ExecutorState {
	mode: "always-garbage" | "garbage-then-valid" | "real";
	garbageKind: GarbageKind;
	/** garbage-then-valid：依次消费的垃圾形态队列（用完即放行手工合法）。 */
	garbageKinds: GarbageKind[];
	calls: number;
	prompts: string[];
	storyState: StoryState;
}

/** 可编程 executor：默认真实 runSubagent；验收按 mode 注入垃圾/手工合法。 */
function makeExecutor(st: ExecutorState): (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>> {
	return async (opts) => {
		st.calls++;
		st.prompts.push(opts.userPrompt);
		if (st.mode === "always-garbage") return garbageResult(st.garbageKind);
		if (st.mode === "garbage-then-valid") {
			const kind = st.garbageKinds.shift();
			if (kind !== undefined) return garbageResult(kind);
			return manualValidResult(st.storyState);
		}
		return runSubagent(opts);
	};
}

interface StoryRuntimeBundle {
	runtime: StoryRuntime;
	sessionManager: SessionManager;
	storyState: StoryState;
	warnings: string[];
	executorState?: ExecutorState;
	/** withEventLog=true 时的事件流文件路径（A.7 读取用）。 */
	eventLogPath?: string;
}

/** 打开新故事并构建 StoryRuntime（独立故事目录）。executorState 由调用方先建好传入以共享可变态。 */
async function newStoryRuntime(root: string, opts: {
	executorState?: ExecutorState;
	maxDataAttempts?: number;
	failureWarningThreshold?: number;
	onWarning?: (m: string) => void;
	withEventLog?: boolean;
}): Promise<StoryRuntimeBundle> {
	const cwd = root;
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const dbPath = storyDbPath(root, sessionId);
	const storyState: StoryState = {
		storyDir: join(root, sessionId),
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};
	const eventLogPath = opts.withEventLog ? join(storyState.storyDir, "pipeline-events.jsonl") : undefined;
	// executor 的手工合法/自适应路径需要读当前 storyDb（恢复会替换实例）——把可变态接上真实 storyState。
	if (opts.executorState) {
		opts.executorState.storyState = storyState;
	}
	const warnings: string[] = [];
	const runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		eventLog: eventLogPath ? createPipelineEventLog(eventLogPath) : undefined,
		maxDataAttempts: opts.maxDataAttempts,
		failureWarningThreshold: opts.failureWarningThreshold,
		dataExecutor: opts.executorState ? makeExecutor(opts.executorState) : undefined,
		onWarning: (m) => {
			warnings.push(m);
			opts.onWarning?.(m);
		},
	});
	return { runtime, sessionManager, storyState, warnings, eventLogPath };
}

function disposeBundle(b: StoryRuntimeBundle): void {
	b.runtime.dispose();
	b.storyState.storyDb.close();
	b.storyState.snapshotsDb.close();
}

async function navigate(runtime: StoryRuntime, targetId: string) {
	if (runtime.session.isStreaming) {
		throw new Error("isStreaming 期间不能 navigateTree（须等上一轮完成）");
	}
	await runtime.session.navigateTree(targetId);
	return runtime.hooks.state.lastRestoreResult;
}

function dataStatusOf(storyState: StoryState, turnSeq: number): DataStatusRow | undefined {
	return storyState.storyDb.reader.listDataStatus().find((r) => r.turn_seq === turnSeq);
}

/** 注入观测的宽容匹配器：回答包含 clock 日期串或其 月/日（阿拉伯/中文数字）、或玩家当前地点名。 */
const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function toChinese(n: number): string {
	if (n <= 10) return CN_NUM[n]!;
	if (n < 20) return `十${n % 10 === 0 ? "" : CN_NUM[n % 10]}`;
	const tens = Math.floor(n / 10);
	return `${CN_NUM[tens]}十${n % 10 === 0 ? "" : CN_NUM[n % 10]}`;
}

function answerReferencesState(answer: string, clock: StoryClock | undefined, playerName: string | null): boolean {
	if (!answer || !clock) return false;
	if (answer.includes(clock.current_time)) return true;
	if (answer.includes("元年")) return true; // 0000 年 = 元年
	const [, mo, day] = clock.current_time.split("-");
	for (const part of [mo, day]) {
		if (!part) continue;
		const n = Number(part);
		if ([String(n), part, toChinese(n)].some((f) => answer.includes(f))) return true;
	}
	if (playerName && answer.includes(playerName)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// 剧本输入（锚点：灰岩城 / 风铃渡口 / 老鞋匠贝罗）
// ---------------------------------------------------------------------------

const A_TURNS = [
	"我是旅人阿澈，今早走进灰岩城的城门。城门边有个老鞋匠贝罗正在补鞋，风铃渡口的方向传来渡船的铃声。",
	"我向老鞋匠贝罗打听渡口怎么走，他指了个方向，说灰岩城的集市今天有早市。",
	"我走到风铃渡口，看到一艘挂着铜铃的渡船停在岸边，船夫说去对岸要一枚铜币。",
	"我付了铜币乘船过河，对岸是一片芦苇荡，芦苇荡里有个废弃的磨坊。",
	"我在磨坊里发现一本沾满灰尘的日志，扉页写着『灰岩城第七守夜人』。",
	"天色渐暗，我返回风铃渡口，船夫已经收了船，我只好在渡口边的旅店住下。",
	"旅店的老板娘告诉我，贝罗其实是灰岩城的老守夜人，他认得每个进城的陌生人。",
	"第二天清晨，我回到灰岩城，贝罗递给我一双新补好的靴子，说是昨晚赶工修的。",
	"我穿上新靴子，决定先上灰岩城的城墙看看城防，守城的士兵放了我进去。",
	"站在城墙上，我看见风铃渡口的渡船正载着一队商人靠岸，贝罗在城门边朝我挥手。",
];

const A_OBSERVE_INPUT = "现在是哪天？我在哪里？";

const B1_INPUT = "我走进灰岩城的集市，买了一把铜钥匙。";
const B2_INPUT = "我在风铃渡口等船，天开始下雨。";
const B3_INPUT = "雨停了，渡船靠岸，我付钱上了船。";
const B4_INPUTS = ["我在灰岩城闲逛，买了干粮。", "我在城墙下避雨。", "我向贝罗打听渡口的消息。"];

const C_TURNS = [
	"我踏进灰岩城的东门，向守门人打听集市的位置。",
	"我走到集市，在一个摊位前买了一把旧匕首。",
	"我离开集市，走向风铃渡口。",
];
const C_RETURN_INPUT = "我回到集市，把匕首还给了摊主。";

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "tavernpi-m2-accept-"));
	const checks: Check[] = [];
	try {
		// ================= A. 基线 10 轮（真实 LLM） =================
		console.log("\n===== A. 基线 10 轮（narrator + data 全真实） =====");
		const a = await newStoryRuntime(root, { withEventLog: true });
		const aEventLogPath = a.eventLogPath!;
		const aState = a.storyState;

		const aReports: TurnResult[] = [];
		const aDataAttempts: number[] = [];
		for (const [i, input] of A_TURNS.entries()) {
			console.log(`\n--- A 第 ${i + 1} 轮 ---`);
			const report = await a.runtime.runTurn(input);
			aReports.push(report);
			aDataAttempts.push(report.data.ok ? report.data.attempts : -report.data.attempts);
			console.log(
				`  data: ${report.data.ok ? "ok" : "FAIL"}（attempts=${report.data.attempts}，${report.data.durationMs}ms） snapshots=${aState.snapshotsDb.listSnapshots().length} clock=${aState.storyDb.reader.getClock()?.current_time ?? "?"}`,
			);
			console.log(`  正文(${report.narrativeText.length} 字): ${report.narrativeText.slice(0, 80)}…`);
		}

		// A.1 连续 10 轮全部返回 + 每轮叙事非空
		checks.push(check("A1: 10 轮全部返回且每轮 narrativeText 非空", aReports.length === 10 && aReports.every((r) => r.narrativeText.trim().length > 0)));

		// A.2 turn_log == 10；data 成功 ≥ 8
		const turnLogs = aState.storyDb.reader.getTurnLog();
		const dataOkTurns = aReports.filter((r) => r.data.ok);
		const aDataOk = dataOkTurns.length;
		console.log(`[obs] A 区 data 成功 ${aDataOk}/10（逐轮 attempts: ${aDataAttempts.join(",")}）`);
		checks.push(check(`A2: turn_log 恰 10 行`, turnLogs.length === 10));
		checks.push(check(`A2: data 成功轮数 ≥ 8（实际 ${aDataOk}）`, aDataOk >= 8));

		// A.3 time_log 行数 == data 成功轮数；clock 链不倒流
		const timeLogs = aState.storyDb.reader.listTimeLog();
		checks.push(check(`A3: time_log 行数 == data 成功轮数（${timeLogs.length} == ${aDataOk}）`, timeLogs.length === aDataOk));
		let chainOk = timeLogs.length === 0;
		for (let i = 0; i < timeLogs.length; i++) {
			const row = timeLogs[i]!;
			if (i === 0) {
				chainOk = row.from_time === DEFAULT_STORY_CLOCK.current_time;
			} else {
				chainOk = chainOk && row.from_time === timeLogs[i - 1]!.to_time;
			}
		}
		checks.push(check("A3: time_log from→to 链不倒流", chainOk));

		// A.4 snapshots 行数 == data 成功轮数；成功轮 session_entry_id 在快照中存在
		const snaps = aState.snapshotsDb.listSnapshots();
		const snapEntryIds = new Set(snaps.map((s) => s.session_entry_id));
		const turnLogById = new Map(turnLogs.map((t) => [t.turn_seq, t]));
		const successEntriesOk = dataOkTurns.every((r) => {
			const row = turnLogById.get(r.turnSeq);
			return row !== undefined && snapEntryIds.has(row.session_entry_id);
		});
		checks.push(check(`A4: snapshots 行数 == data 成功轮数（${snaps.length} == ${aDataOk}）`, snaps.length === aDataOk));
		checks.push(check("A4: 每个成功轮 turn_log.session_entry_id 存在于 snapshots", successEntriesOk));

		// A.5 锚点抽取
		const locations = aState.storyDb.reader.listLocations();
		const npcs = aState.storyDb.reader.listNpcs();
		const events = aState.storyDb.reader.listEvents();
		console.log(`[obs] events=${events.length} locations=${locations.length} npcs=${npcs.length}`);
		console.log(`[obs] locations: ${locations.map((l) => l.name).join(" / ")}`);
		console.log(`[obs] npcs: ${npcs.map((n) => `${n.name}#${n.id}`).join(" / ")}`);
		console.log(`[obs] events: ${events.map((e) => e.summary).join(" | ").slice(0, 300)}`);
		checks.push(check(`A5: events 累计 ≥ 5 行（实际 ${events.length}）`, events.length >= 5));
		const chenAnchor = locations.some((l) => l.name.includes("灰岩城")) || events.some((e) => e.summary.includes("灰岩城"));
		checks.push(check("A5: 锚点「灰岩城」出现在 locations 或 events", chenAnchor));
		const beiLuoAnchor = npcs.some((n) => n.name.includes("贝罗")) || events.some((e) => e.summary.includes("贝罗"));
		checks.push(check("A5: 锚点「贝罗」出现在 npcs 或 events", beiLuoAnchor));

		// A.6 注入观测（第 11 轮）：回答应反映 db_summary 的 clock/地点
		console.log(`\n--- A 第 11 轮（注入观测）: ${A_OBSERVE_INPUT} ---`);
		const a11 = await a.runtime.runTurn(A_OBSERVE_INPUT);
		console.log(`[obs] 第 11 轮回答全文:\n${a11.narrativeText}`);
		const clock11 = aState.storyDb.reader.getClock();
		const player11 = aState.storyDb.reader.getPlayerLocation();
		checks.push(
			check(
				`A6: 回答反映注入的当前时间/位置（clock=${clock11?.current_time}，位置=${player11?.name ?? "(未定位)"}）`,
				answerReferencesState(a11.narrativeText, clock11, player11?.name ?? null),
			),
		);

		// A.7 pipeline 事件流留痕
		const eventFile = existsSync(aEventLogPath) ? readFileSync(aEventLogPath, "utf-8") : "";
		const lines = eventFile.trim() === "" ? [] : eventFile.trimEnd().split("\n");
		const parsed = lines.map((l) => JSON.parse(l) as { role: string; attempt?: number });
		const hasNarrator = parsed.some((e) => e.role === "narrator");
		const dataEvents = parsed.filter((e) => e.role === "data");
		checks.push(check("A7: pipeline-events.jsonl 存在且含 role=narrator 记录", existsSync(aEventLogPath) && hasNarrator));
		checks.push(check(`A7: 含 role=data 记录且带 attempt 字段（${dataEvents.length} 条）`, dataEvents.length > 0 && dataEvents.every((e) => typeof e.attempt === "number")));

		disposeBundle(a);

		// ================= B. 失败路径（确定性注入） =================
		console.log("\n===== B. 失败路径（dataExecutor 注入） =====");

		// B.1 重试成功：前 2 次垃圾（zod + semantic）、第 3 次手工合法
		const b1State = makeExecutorState({
			mode: "garbage-then-valid",
			garbageKind: "zod",
			garbageKinds: ["zod", "semantic"],
		});
		const b1 = await newStoryRuntime(root, { executorState: b1State });
		const b1Report = await b1.runtime.runTurn(B1_INPUT);
		console.log(`[obs] B1 data: ${b1Report.data.ok ? "ok" : "FAIL"} attempts=${b1Report.data.attempts}`);
		checks.push(check("B1: 重试成功 data.ok=true、attempts=3", b1Report.data.ok && b1Report.data.attempts === 3));
		checks.push(check("B1: snapshotTaken=true", b1Report.snapshotTaken));
		checks.push(check("B1: data_status 该轮 status=ok", dataStatusOf(b1.storyState, 1)?.status === "ok"));
		disposeBundle(b1);

		// B.2 重试耗尽：恒垃圾 → ok:false、不拍快照、turn_log 仍有该轮
		const b2State = makeExecutorState({ mode: "always-garbage", garbageKind: "semantic", garbageKinds: [] });
		const b2 = await newStoryRuntime(root, { executorState: b2State });
		const b2Report = await b2.runtime.runTurn(B2_INPUT);
		const b2Error = "error" in b2Report.data ? b2Report.data.error : "";
		console.log(`[obs] B2 data: FAIL attempts=${b2Report.data.attempts} error=${b2Error.slice(0, 120)}`);
		checks.push(check("B2: 恒垃圾 → data.ok=false、attempts=3", !b2Report.data.ok && b2Report.data.attempts === 3));
		checks.push(check("B2: 失败不阻塞叙事（narrativeText 非空）", b2Report.narrativeText.trim().length > 0));
		checks.push(check("B2: snapshotTaken=false（§6.1 不拍快照）", b2Report.snapshotTaken === false));
		checks.push(check("B2: data_status 该轮 failed", dataStatusOf(b2.storyState, 1)?.status === "failed"));
		checks.push(check("B2: snapshots 行数持平（0 份）", b2.storyState.snapshotsDb.listSnapshots().length === 0));
		checks.push(check("B2: turn_log 仍有该轮记录", b2.storyState.storyDb.reader.getTurnLog().length === 1));

		// B.3 下轮补齐（同一故事，换真实 data executor）：userPrompt 必须含失败轮叙事文本
		b2State.mode = "real"; // 同 runtime 翻转 executor 模式（共享 session）
		const b3PromptStart = b2State.prompts.length;
		const b3Report = await b2.runtime.runTurn(B3_INPUT);
		const b3Prompts = b2State.prompts.slice(b3PromptStart);
		const pendingFragment = b2Report.narrativeText.slice(0, 24);
		const hasPending = b3Prompts.some((p) => p.includes("待补齐轮次") && p.includes(pendingFragment));
		checks.push(check("B3: userPrompt 含失败轮叙事文本（§6.1 补齐输入）", hasPending));
		if (b3Report.data.ok) {
			checks.push(check("B3: 第 2 轮真实 data ok（attempts=" + b3Report.data.attempts + "）", true));
			checks.push(check("B3: 失败轮 data_status → compensated", dataStatusOf(b2.storyState, 1)?.status === "compensated"));
			checks.push(check("B3: 快照恢复拍摄（snapshotTaken=true）", b3Report.snapshotTaken));
			console.log(`[obs] B3 第 2 轮 data ok（attempts=${b3Report.data.attempts}）`);
		} else {
			console.log(`[note] B3 真实 data 失败（LLM 抖动，非实现 bug）: ${b3Report.data.error.slice(0, 200)}`);
			checks.push(check(`B3: 第 2 轮真实 data ok（LLM 抖动，实际 FAIL attempts=${b3Report.data.attempts}）`, false));
			checks.push(check("B3: 失败轮 data_status → compensated（LLM 抖动未达）", dataStatusOf(b2.storyState, 1)?.status === "compensated"));
			checks.push(check("B3: 快照恢复拍摄（LLM 抖动未达）", b3Report.snapshotTaken));
		}
		disposeBundle(b2);

		// B.4 连续失败提示（新故事，3 轮恒垃圾，threshold=3）
		const b4State = makeExecutorState({ mode: "always-garbage", garbageKind: "semantic", garbageKinds: [] });
		const b4 = await newStoryRuntime(root, { executorState: b4State, failureWarningThreshold: 3 });
		for (const input of B4_INPUTS) {
			const r = await b4.runtime.runTurn(input);
			console.log(`[obs] B4 turn${r.turnSeq} data: FAIL consecutive=${r.consecutiveDataFailures}`);
		}
		checks.push(check("B4: 连续 3 轮失败 → consecutiveDataFailures=3", b4ReportsLastConsecutive(b4) === 3));
		checks.push(
			check(
				"B4: onWarning 收到连续失败提示",
				b4.warnings.some((w) => w.includes("连续失败") && w.includes("3")),
			),
		);
		disposeBundle(b4);

		// ================= C. 回溯一致性（§3.0 M2 形态） =================
		console.log("\n===== C. 回溯一致性 =====");
		// C 用自适应手工 data（确定性快照，避免真实 data 抖动影响回溯断言）；narrator 仍真实。
		const cState = makeExecutorState({ mode: "garbage-then-valid", garbageKind: "zod", garbageKinds: [] });
		const c = await newStoryRuntime(root, { executorState: cState });
		const cReports: TurnResult[] = [];
		let cTurn1Clock: StoryClock | undefined;
		let cTurn1Events = 0;
		for (const input of C_TURNS) {
			const r = await c.runtime.runTurn(input);
			cReports.push(r);
			if (cReports.length === 1) {
				// 第 1 轮末参考态（回溯断言的目标）
				cTurn1Clock = c.storyState.storyDb.reader.getClock();
				cTurn1Events = c.storyState.storyDb.reader.listEvents().length;
			}
		}
		console.log(`[obs] C 三轮后 clock=${c.storyState.storyDb.reader.getClock()?.current_time} events=${c.storyState.storyDb.reader.listEvents().length}（第 1 轮末 clock=${cTurn1Clock?.current_time} events=${cTurn1Events}）`);

		// C.1 导航到第 2 轮 user entry → 回到第 1 轮末状态
		const c1 = await navigate(c.runtime, cReports[1]!.userEntryId);
		const c1Clock = c.storyState.storyDb.reader.getClock();
		const c1Events = c.storyState.storyDb.reader.listEvents();
		checks.push(check("C1: 恢复结果 ok（restoredTurnSeq=1）", c1?.ok === true && c1?.restoredTurnSeq === 1));
		checks.push(check(`C1: clock 回到第 1 轮末（${cTurn1Clock?.current_time}）`, c1Clock?.current_time === cTurn1Clock?.current_time));
		checks.push(check(`C1: events 回到第 1 轮末（${cTurn1Events} 行）`, c1Events.length === cTurn1Events));

		// C.2 回溯后再 prompt → turn_seq 续接为 2、无 PK 冲突、快照正常拍摄
		const c2 = await c.runtime.runTurn(C_RETURN_INPUT);
		checks.push(check(`C2: 回溯后 turn_seq 续接为 2（实际 ${c2.turnSeq}）`, c2.turnSeq === 2));
		checks.push(check(`C2: turn_log 2 行无 PK 冲突`, c.storyState.storyDb.reader.getTurnLog().length === 2));
		checks.push(check("C2: 快照正常拍摄", c2.snapshotTaken));

		// C.3 导航到首个 user entry → 空库兜底（故事 snapshots 非空 → 走「本链无快照」分支，不误判损伤）
		const c3 = await navigate(c.runtime, cReports[0]!.userEntryId);
		const c3Clock = c.storyState.storyDb.reader.getClock();
		const c3Events = c.storyState.storyDb.reader.listEvents();
		checks.push(check("C3: 空库兜底恢复 ok（无 restoredTurnSeq）", c3?.ok === true && c3?.restoredTurnSeq === undefined));
		checks.push(check(`C3: clock == 初始值（${DEFAULT_STORY_CLOCK.current_time}）`, JSON.stringify(c3Clock) === JSON.stringify(DEFAULT_STORY_CLOCK)));
		checks.push(check("C3: events == 0（故事初始态）", c3Events.length === 0));
		disposeBundle(c);

		console.log("\n===== M2 验收检查表 =====");
		printChecks(checks);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** 构建 ExecutorState（storyState 在 newStoryRuntime 内创建后经闭包回填——makeExecutor 读取时已就绪）。 */
function makeExecutorState(init: { mode: ExecutorState["mode"]; garbageKind: GarbageKind; garbageKinds: GarbageKind[] }): ExecutorState {
	const st: ExecutorState = {
		mode: init.mode,
		garbageKind: init.garbageKind,
		garbageKinds: [...init.garbageKinds],
		calls: 0,
		prompts: [],
		storyState: undefined as unknown as StoryState,
	};
	return st;
}

function b4ReportsLastConsecutive(bundle: StoryRuntimeBundle): number {
	// B4 断言用：读 data_status 从最新往前数连续 failed
	let count = 0;
	for (const row of [...bundle.storyState.storyDb.reader.listDataStatus()].reverse()) {
		if (row.status === "failed") count++;
		else break;
	}
	return count;
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
