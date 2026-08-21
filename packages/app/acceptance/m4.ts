// M4 故事驱动集成验收（创作规划 §6.3 / §6.4 / §7-M4）：story 阶段（场景分析/轻检/打回/全统筹）+ stylize 自断言脚本。
//
// 五区：
// A. 场景分析正常流转（真实 LLM，3 轮）：场景卡产出非兜底 / onstage 驱动 npc 调度一致 / 时间零幻觉 /
//    story_scene eventLog / 场景卡注入主叙事 / data 正常（timeSuggestion 链路不破坏落库）。
// B. 打回与超限放行（§6.3 核心契约；story_review 桩注入，确定性）：dead NPC 报疑 → 审查 hard → 打回重写；
//    maxRevisions 耗尽 → 超限放行 + data strictDrop（时间倒流项剔除、正常事件落库、clock 不倒流）。
// C. 全统筹与批注注入（真实 LLM，3 轮，overseeEveryTurns=2）：K 轮触发 → 批注跨轮注入下一轮主叙事；
//    major_event 在非 K 轮触发统筹。
// D. stylize 零漂移（§6.4）：真实路径（applied 或回退皆契约允许）+ 桩 drift 路径（factCheck 拒绝 →
//    applied=false、原文回退、eventLog ok:false）。
// E. 回归与冒烟：npm test / typecheck / m1/m2/m3:accept 外部执行（见报告）；m4-cli 两种冒烟
//    （story+npc 一轮 / --stylize 一轮）。
//
// 成本控制：A 3 轮 + B 2 轮 + C 3 轮 + D 2 轮（每轮 4-6 次 LLM 调用）+ E 两次 cli 冒烟。
// 需要 auth.json（M0 已配）。结束时清理临时目录。
//
// 运行：npm run m4:accept（或 node packages/app/acceptance/m4.ts）。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	createPipelineEventLog,
	createStoryRuntime,
	findUserEntryOnBranch,
	openSnapshotsDb,
	openStoryDb,
	runSubagent,
	snapshotsDbPath,
	storyDbPath,
	stylizeFactCheck,
	type PipelineEvent,
	type StoryDb,
	type StoryRuntime,
	type StoryState,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
	type TurnResult,
} from "@tavernpi/core";

const repoRoot = resolve(import.meta.dirname, "../../..");
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
	console.log(`===== M4 验收: ${failed === 0 ? "PASS" : "FAIL"}（${passCount}/${checks.length} 通过） =====`);
	if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** ISO 日期 +1 天（不用 JS Date：0-99 年会被解释成 1900+）。 */
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

/** 文本消息提取（content 数组或纯字符串）。 */
function messageText(message: { role: string; content?: unknown }): string {
	if (Array.isArray(message.content)) {
		return (message.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
	}
	return typeof message.content === "string" ? message.content : "";
}

/** 会话树中全部 assistant 正文（按条目顺序；末位 = 最终稿，前一位 = 初稿/打回稿）。 */
function assistantReplies(sessionManager: SessionManager): string[] {
	return sessionManager
		.getEntries()
		.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message" && e.message.role === "assistant")
		.map((e) => messageText(e.message))
		.filter((t) => t.trim().length > 0);
}

// ---------------------------------------------------------------------------
// 确定性 setup（writer 直写 seed）
// ---------------------------------------------------------------------------

interface M4Seed {
	tavern: { id: number };
	market: { id: number };
	mei: { id: number };
	finn: { id: number };
	berlo: { id: number };
	/** B 区：dead NPC 老王（规则层报疑 5 的触发器）。 */
	laowang?: { id: number };
}

function seedM4Story(storyDb: StoryDb, opts: { withDeadNpc?: boolean } = {}): M4Seed {
	const w = storyDb.writer;
	const tavern = w.insertLocation({ name: "酒馆" });
	const market = w.insertLocation({ name: "市集" });
	w.moveSubject({ turnSeq: 0, subject: "player", toLocationId: tavern.id, note: "seed" });
	const mei = w.insertNpc({ name: "梅姑" });
	const finn = w.insertNpc({ name: "芬恩" });
	const berlo = w.insertNpc({ name: "贝罗" });
	w.moveSubject({ turnSeq: 0, subject: `npc:${mei.id}`, toLocationId: tavern.id, note: "seed" });
	w.moveSubject({ turnSeq: 0, subject: `npc:${finn.id}`, toLocationId: tavern.id, note: "seed" });
	w.moveSubject({ turnSeq: 0, subject: `npc:${berlo.id}`, toLocationId: market.id, note: "seed" });
	w.insertNpcTrait({ npcId: mei.id, trait: "精明吝啬", weight: 5, turnSeq: 0 });
	w.insertNpcTrait({ npcId: mei.id, trait: "逢人推销自家梅子酒", weight: 4, turnSeq: 0 });
	w.insertNpcMemory({ npcId: mei.id, turnSeq: 0, kind: "观察", content: "记得老主顾的赊账", salience: 3 });
	w.insertNpcTrait({ npcId: finn.id, trait: "爱吹牛", weight: 5, turnSeq: 0 });
	w.insertNpcTrait({ npcId: finn.id, trait: "暗恋梅姑不敢承认", weight: 4, turnSeq: 0 });
	w.insertNpcMemory({ npcId: berlo.id, turnSeq: 0, kind: "生活", content: "常年在市集摆摊补鞋", salience: 2 });
	let laowang: { id: number } | undefined;
	if (opts.withDeadNpc) {
		const dead = w.insertNpc({ name: "老王", status: "dead" });
		w.insertNpcMemory({ npcId: dead.id, turnSeq: 0, kind: "生前", content: "酒馆老常客，上月过世", salience: 3 });
		laowang = { id: dead.id };
	}
	return { tavern: { id: tavern.id }, market: { id: market.id }, mei: { id: mei.id }, finn: { id: finn.id }, berlo: { id: berlo.id }, laowang };
}

// ---------------------------------------------------------------------------
// 故事运行态（npc + story 开启；可选 stylize；eventLog / onSystemPromptRender 观测）
// ---------------------------------------------------------------------------

interface M4Bundle {
	runtime: StoryRuntime;
	sessionManager: SessionManager;
	storyState: StoryState;
	seed: M4Seed;
	warnings: string[];
	systemPrompts: string[];
	eventRecords: PipelineEvent[];
}

async function newM4Runtime(
	root: string,
	opts: {
		offscreenAfterTurns?: number;
		overseeEveryTurns?: number;
		maxRevisions?: number;
		storyExecutor?: (o: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		stylize?: { enabled: boolean; styleHint?: string; executor?: (o: SubagentRunOptions) => Promise<SubagentResult<unknown>> };
		dataExecutor?: (o: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		withDeadNpc?: boolean;
	},
): Promise<M4Bundle> {
	const cwd = root;
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const dbPath = storyDbPath(root, sessionId);
	const storyState: StoryState = {
		storyDir: join(root, sessionId),
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};
	const seed = seedM4Story(storyState.storyDb, { withDeadNpc: opts.withDeadNpc });
	const eventLog = createPipelineEventLog();
	const eventRecords: PipelineEvent[] = [];
	eventLog.on((e) => eventRecords.push(e));
	const systemPrompts: string[] = [];
	const warnings: string[] = [];
	const runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		eventLog,
		npc: { enabled: true, offscreenAfterTurns: opts.offscreenAfterTurns ?? 99 },
		story: {
			enabled: true,
			overseeEveryTurns: opts.overseeEveryTurns ?? 99,
			...(opts.maxRevisions !== undefined ? { maxRevisions: opts.maxRevisions } : {}),
			executor: opts.storyExecutor,
		},
		stylize: opts.stylize?.enabled
			? { enabled: true, styleHint: opts.stylize.styleHint, executor: opts.stylize.executor }
			: undefined,
		dataExecutor: opts.dataExecutor,
		onWarning: (m) => warnings.push(m),
		onSystemPromptRender: (rendered) => systemPrompts.push(rendered),
	});
	return { runtime, sessionManager, storyState, seed, warnings, systemPrompts, eventRecords };
}

function disposeBundle(b: M4Bundle): void {
	b.runtime.dispose();
	b.storyState.storyDb.close();
	b.storyState.snapshotsDb.close();
}

// ---------------------------------------------------------------------------
// 剧本输入
// ---------------------------------------------------------------------------

const A_TURNS = [
	"我推开酒馆的门，朝柜台后的梅姑招手，要了一壶她自酿的梅子酒。",
	"我坐到吹牛的芬恩旁边，听他讲南方的冒险，偶尔接一句。",
	"梅姑端来一盘花生米，我向她打听市集上卖刀的行商。",
];

const C_TURNS = [
	"我走进酒馆，向梅姑要了一碗热汤，坐在窗边慢慢喝。",
	"芬恩过来讲他昨夜的梦，我听得入神，梅姑在柜台后笑。",
	"我向梅姑打听市集上的布商，她说最近生意不错。",
];

const D1_INPUT = "我推开酒馆的门，梅姑迎上来，我把一枚铜钱放在柜台上，要了一壶梅子酒。";

const LAOWANG_INPUT = "老王在柜台边坐下，我与他碰杯叙旧，问他近来如何。";

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "tavernpi-m4-accept-"));
	const checks: Check[] = [];
	try {
		// ================= A. 场景分析正常流转（真实 LLM，3 轮） =================
		console.log("\n===== A. 场景分析正常流转（offscreen/oversee 屏蔽） =====");
		const a = await newM4Runtime(root, { offscreenAfterTurns: 99, overseeEveryTurns: 99 });
		for (const [i, input] of A_TURNS.entries()) {
			console.log(`\n--- A 第 ${i + 1} 轮 ---`);
			const clockBefore = a.storyState.storyDb.reader.getClock()?.current_time;
			const promptStart = a.systemPrompts.length;
			const report = await a.runtime.runTurn(input);
			const turnLabel = `A 第 ${i + 1} 轮`;
			const s = report.story;

			// A.1 场景卡存在且非兜底
			checks.push(check(`${turnLabel} A1: sceneCard 存在且 sceneFallback=false（${s?.sceneFallback}）`, s !== undefined && s.sceneFallback === false));

			// A.2 场景卡 onstage ⊆ 注册 NPC；npc.onstage 与场景卡一致（场景卡驱动调度）
			const registered = new Set(a.storyState.storyDb.reader.listNpcs().map((n) => n.id));
			const cardOnstage = s?.sceneCard.onstage_npc_ids ?? [];
			const onstageSubset = cardOnstage.length > 0 && cardOnstage.every((id) => registered.has(id));
			const npcOnstage = (report.npc?.onstageNpcIds ?? []).slice().sort((x, y) => x - y);
			const cardOnstageSorted = cardOnstage.slice().sort((x, y) => x - y);
			checks.push(check(`${turnLabel} A2: onstage_npc_ids 非空且 ⊆ 注册 NPC（${JSON.stringify(cardOnstage)}）`, onstageSubset));
			checks.push(
				check(
					`${turnLabel} A2: npc.onstageNpcIds 与场景卡一致（npc=${JSON.stringify(npcOnstage)} card=${JSON.stringify(cardOnstageSorted)}）`,
					JSON.stringify(npcOnstage) === JSON.stringify(cardOnstageSorted),
				),
			);

			// A.3 场景卡时间 == prompt 前 clock（时间幻觉零容忍）
			const cardTime = s?.sceneCard.current_story_time;
			console.log(`[obs] ${turnLabel} sceneCard: 时间=${cardTime}（prompt 前 clock=${clockBefore}） goal="${s?.sceneCard.scene_goal}" onstage=${JSON.stringify(cardOnstage)} fallback=${s?.sceneFallback}`);
			checks.push(check(`${turnLabel} A3: current_story_time == prompt 前 clock（${cardTime} == ${clockBefore}）`, cardTime === clockBefore));

			// A.4 eventLog 有 story_scene 记录
			const sceneRecords = a.eventRecords.filter((e) => e.role === "story_scene" && e.turnSeq === report.turnSeq);
			checks.push(check(`${turnLabel} A4: eventLog 有 role=story_scene 记录（${sceneRecords.length} 条，attempt=${sceneRecords[0]?.attempt}）`, sceneRecords.length > 0 && typeof sceneRecords[0]?.attempt === "number"));

			// A.5 场景卡注入主叙事（onSystemPromptRender 捕获）
			const sysPrompt = a.systemPrompts.slice(promptStart).join("\n");
			const goal = s?.sceneCard.scene_goal ?? "";
			const injectOk =
				sysPrompt.includes("导演场景卡") &&
				sysPrompt.includes("场景目标:") &&
				(goal.trim() === "" ? true : sysPrompt.includes(goal));
			checks.push(check(`${turnLabel} A5: 系统提示含场景卡内容（导演场景卡/场景目标${goal.trim() !== "" ? `/目标文本` : ""}）`, injectOk));

			// A.6 data.ok（timeSuggestion 链路不破坏落库）
			console.log(`[obs] ${turnLabel} data=${report.data.ok ? "ok" : "FAIL"} snapshot=${report.snapshotTaken}`);
			checks.push(check(`${turnLabel} A6: data.ok（timeSuggestion 链路不破坏落库）`, report.data.ok));
		}
		const aTimeLogs = a.storyState.storyDb.reader.listTimeLog();
		console.log(`[obs] A 区 3 轮后 time_log = ${aTimeLogs.length} 行`);
		checks.push(check(`A7: 3 轮后 time_log 3 行（实际 ${aTimeLogs.length}）`, aTimeLogs.length === 3));
		disposeBundle(a);

		// ================= B1. 打回重写（story_review 桩注入 hard finding） =================
		console.log("\n===== B1. 打回重写（dead NPC 报疑 → 审查 hard → 打回重写） =====");
		const b1ReviewExecutor = async (opts: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			if (opts.role === "story_review") {
				return stubResult({ findings: [{ kind: "timeline", description: "叙事时间与库内时钟矛盾（注入）", severity: "hard" }] });
			}
			return runSubagent(opts);
		};
		const b1 = await newM4Runtime(root, { offscreenAfterTurns: 99, overseeEveryTurns: 99, storyExecutor: b1ReviewExecutor, withDeadNpc: true });
		const b1t1 = await b1.runtime.runTurn("我走进酒馆，向梅姑要了碗热汤，在角落坐下。"); // 干净首轮，确保第 2 轮有快照可恢复
		console.log(`[obs] B1 首轮 data=${b1t1.data.ok ? "ok" : "FAIL"} snapshot=${b1t1.snapshotTaken}`);
		const b1Report = await b1.runtime.runTurn(LAOWANG_INPUT); // 报疑触发轮
		const b1s = b1Report.story!;
		const b1Replies = assistantReplies(b1.sessionManager);
		console.log(`[obs] B1 第 2 轮: revisions=${b1s.revisions} released=${b1s.releasedWithWarnings} hardConflicts=${b1s.hardConflicts.length} suspicions=${b1s.suspicions.length} findings=${b1s.reviewFindings.length}`);
		if (b1s.revisions >= 1) {
			console.log(`[obs] B1 初稿（前 ${b1Replies.at(-2)?.length ?? 0} 字）: ${(b1Replies.at(-2) ?? "").slice(0, 160)}`);
			console.log(`[obs] B1 最终稿: ${b1Report.narrativeText.slice(0, 160)}`);
		}
		const b1Mechanism = b1s.revisions >= 1 || b1s.releasedWithWarnings === true;
		checks.push(check(`B1: 打回机制生效（revisions=${b1s.revisions} 或 released=${b1s.releasedWithWarnings}）`, b1Mechanism));
		checks.push(
			check("B1: userEntryId 在最终 leaf 祖先链上（findUserEntryOnBranch 语义）", findUserEntryOnBranch(b1.sessionManager.getEntries(), b1Report.leafId) === b1Report.userEntryId),
		);
		const b1TurnLog = b1.storyState.storyDb.reader.getTurnLog().find((t) => t.turn_seq === b1Report.turnSeq);
		checks.push(check("B1: turn_log/snapshot 绑定最终 leafId", b1TurnLog?.session_entry_id === b1Report.leafId));
		checks.push(check("B1: 最终叙事非空", b1Report.narrativeText.trim().length > 0));
		checks.push(check(`B1: data.ok（实际 ${b1Report.data.ok ? "ok" : "FAIL"}）`, b1Report.data.ok));
		disposeBundle(b1);

		// ================= B2. 超限放行 + strictDrop 落库（确定性） =================
		console.log("\n===== B2. 超限放行 + data strictDrop（时间倒流项剔除、其余照落） =====");
		const b2DataExecutor = async (): Promise<SubagentResult<unknown>> =>
			stubResult({
				events: [{ summary: "验收合法事件" }],
				time_advance: { to_time: "0000-00-01", span_note: "倒流注入" }, // 早于初始 clock → 语义硬冲突
				new_locations: [],
				location_moves: [],
				new_npcs: [],
				npc_updates: [],
				world_state: [],
			});
		const b2 = await newM4Runtime(root, {
			offscreenAfterTurns: 99,
			overseeEveryTurns: 99,
			maxRevisions: 1,
			storyExecutor: b1ReviewExecutor, // review 恒 hard → 两稿都打回 → 超限放行
			dataExecutor: b2DataExecutor,
			withDeadNpc: true,
		});
		await b2.runtime.runTurn("我走进酒馆，向梅姑要了碗热汤，在角落坐下。");
		const b2Report = await b2.runtime.runTurn(LAOWANG_INPUT);
		const b2s = b2Report.story!;
		const b2TurnLog = b2.storyState.storyDb.reader.getTurnLog().find((t) => t.turn_seq === b2Report.turnSeq);
		const b2Clock = b2.storyState.storyDb.reader.getClock()?.current_time;
		const b2Events = b2.storyState.storyDb.reader.listEvents();
		const b2Dropped = b2Report.data.ok ? b2Report.data.dropped ?? [] : [];
		console.log(`[obs] B2: revisions=${b2s.revisions} released=${b2s.releasedWithWarnings} warnings="${(b2TurnLog?.warnings ?? "").slice(0, 120)}"`);
		console.log(`[obs] B2: data.ok=${b2Report.data.ok} dropped=${JSON.stringify(b2Dropped)} clock=${b2Clock} events=${b2Events.map((e) => e.summary).join(" | ")}`);
		checks.push(check(`B2: releasedWithWarnings=true（实际 ${b2s.releasedWithWarnings}）`, b2s.releasedWithWarnings === true));
		checks.push(check("B2: turn_log 该轮 warnings 非空（§6.3 留痕）", (b2TurnLog?.warnings ?? "").trim().length > 0));
		checks.push(
			check(
				`B2: data.ok 且 dropped 含 time_advance 项（实际 ${JSON.stringify(b2Dropped.map((d) => d.item))}）`,
				b2Report.data.ok && b2Dropped.some((d) => d.item === "time_advance"),
			),
		);
		checks.push(check(`B2: clock 未倒流（仍 ${b2Clock}）`, b2Clock === "0000-01-01"));
		checks.push(check("B2: 正常事件已落库（其余照落）", b2Events.some((e) => e.summary === "验收合法事件")));
		disposeBundle(b2);

		// ================= C. 全统筹与批注注入（真实 LLM，3 轮，K=2） =================
		console.log("\n===== C. 全统筹与批注注入（overseeEveryTurns=2；major_event 触发路径） =====");
		const cForceMajor = { on: false };
		const cExecutor = async (opts: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			const r = await runSubagent(opts);
			if (opts.role === "story_scene" && cForceMajor.on) {
				(r.output as { major_event?: boolean }).major_event = true;
			}
			return r;
		};
		const c = await newM4Runtime(root, { offscreenAfterTurns: 99, overseeEveryTurns: 2, storyExecutor: cExecutor });
		const c1 = await c.runtime.runTurn(C_TURNS[0]!);
		checks.push(check(`C1: 第 1 轮 oversee 缺省（实际 ${c1.oversee === undefined ? "缺省" : JSON.stringify(c1.oversee)}）`, c1.oversee === undefined));

		const c2 = await c.runtime.runTurn(C_TURNS[1]!);
		const c2Note = c2.oversee;
		const c2Shape =
			c2Note !== null &&
			c2Note !== undefined &&
			typeof c2Note.pacing === "string" &&
			Array.isArray(c2Note.suggestions) &&
			c2Note.phase_advice !== undefined &&
			typeof c2Note.phase_advice.action === "string";
		console.log(`[obs] C2: oversee=${c2Note === undefined ? "(无)" : c2Note === null ? "(null 失败)" : `pacing="${c2Note.pacing.slice(0, 60)}" suggestions=${c2Note.suggestions.length} phase=${c2Note.phase_advice.action}`}`);
		checks.push(check(`C2: 第 2 轮 oversee 非空且结构完整（K=2 触发）`, c2Shape));
		checks.push(check(`C2: eventLog 第 2 轮有 role=story_oversee 记录`, c.eventRecords.some((e) => e.role === "story_oversee" && e.turnSeq === c2.turnSeq)));

		// 第 3 轮：非 K 轮 + major_event 触发；并断言第 2 轮批注跨轮注入
		cForceMajor.on = true;
		const promptStart3 = c.systemPrompts.length;
		const c3 = await c.runtime.runTurn(C_TURNS[2]!);
		cForceMajor.on = false;
		const sysPrompt3 = c.systemPrompts.slice(promptStart3).join("\n");
		const c2Suggestion = c2Note !== null && c2Note !== undefined && c2Note.suggestions.length > 0 ? c2Note.suggestions[0]! : "";
		const c2Pacing = c2Note !== null && c2Note !== undefined ? c2Note.pacing : "";
		const noteInjected =
			sysPrompt3.includes("以下为全统筹批注") && (c2Suggestion !== "" ? sysPrompt3.includes(c2Suggestion) : sysPrompt3.includes(c2Pacing));
		console.log(`[obs] C3: oversee=${c3.oversee === undefined ? "(无)" : c3.oversee === null ? "(null 失败)" : `pacing="${c3.oversee.pacing.slice(0, 50)}"`}`);
		console.log(`[obs] C3: 注入证据 以下为全统筹批注=${sysPrompt3.includes("以下为全统筹批注")} suggestion 片段=${c2Suggestion !== "" ? sysPrompt3.includes(c2Suggestion) : "(用 pacing)"} ${c2Suggestion !== "" ? `suggestion="${c2Suggestion.slice(0, 60)}"` : ""}`);
		checks.push(check(`C3: 第 3 轮系统提示含「以下为全统筹批注」+ 第 2 轮 suggestion 片段（跨轮注入）`, noteInjected));
		checks.push(check(`C3: 第 3 轮（非 K）oversee 非空——major_event 触发路径`, c3.oversee !== undefined && c3.oversee !== null));
		checks.push(check(`C3: eventLog 第 3 轮有 role=story_oversee 记录`, c.eventRecords.some((e) => e.role === "story_oversee" && e.turnSeq === c3.turnSeq)));
		disposeBundle(c);

		// ================= D1. stylize 真实路径（1 轮） =================
		console.log("\n===== D1. stylize 真实路径（styleHint=古龙式短句） =====");
		const d1 = await newM4Runtime(root, { offscreenAfterTurns: 99, overseeEveryTurns: 99, stylize: { enabled: true, styleHint: "古龙式短句，节奏冷峻" } });
		const d1Report = await d1.runtime.runTurn(D1_INPUT);
		const d1TurnLog = d1.storyState.storyDb.reader.getTurnLog().find((t) => t.turn_seq === d1Report.turnSeq);
		console.log(`[obs] D1: stylize=${d1Report.stylize ? `applied=${d1Report.stylize.applied} drift=${JSON.stringify(d1Report.stylize.drift ?? [])}` : "(无)"}`);
		console.log(`[obs] D1: narrative_text(${d1TurnLog?.narrative_text.length ?? 0}字) raw_text(${d1TurnLog?.raw_text?.length ?? 0}字)`);
		checks.push(check(`D1: TurnResult.stylize 存在`, d1Report.stylize !== undefined));
		let d1BranchOk = false;
		if (d1Report.stylize?.applied === true) {
			const raw = d1TurnLog?.raw_text ?? "";
			const final = d1Report.narrativeText;
			const fact = stylizeFactCheck(raw, final, d1.storyState.storyDb);
			console.log(`[obs] D1: factCheck ok=${fact.ok} drift=${JSON.stringify(fact.drift)}`);
			d1BranchOk = raw.trim().length > 0 && raw !== final && fact.ok === true;
			checks.push(check("D1: applied=true → raw_text 非空且 ≠ narrative_text 且 stylizeFactCheck ok", d1BranchOk));
		} else {
			const raw = d1TurnLog?.raw_text ?? "";
			const drift = d1Report.stylize?.drift ?? [];
			d1BranchOk = d1Report.narrativeText === raw && drift.length > 0;
			checks.push(check("D1: applied=false → narrative_text == raw_text 且 drift 非空（回退路径）", d1BranchOk));
		}
		checks.push(
			check("D1: data 基于最终文本抽取（data.ok）", d1Report.data.ok && d1TurnLog?.narrative_text === d1Report.narrativeText),
		);
		disposeBundle(d1);

		// ================= D2. stylize 桩路径（drift 注入 → factCheck 拒绝 → 回退） =================
		console.log("\n===== D2. stylize 桩路径（drift 注入，确定性） =====");
		const driftExecutor = async (opts: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			const m = /## 待润色原文（不得改变任何事实）\n([\s\S]*?)\n\n## 指令/.exec(opts.userPrompt);
			const original = m?.[1] ?? "（未提取到原文）";
			// 追加数字「5」+ 未出现的实体名「贝罗」→ 零漂移抽查必然拒绝
			return stubResult({ text: `${original}，贝罗的鞋摊今日得了铜钱 5 文。` });
		};
		const d2 = await newM4Runtime(root, { offscreenAfterTurns: 99, overseeEveryTurns: 99, stylize: { enabled: true, executor: driftExecutor } });
		const d2Report = await d2.runtime.runTurn(D1_INPUT);
		const d2TurnLog = d2.storyState.storyDb.reader.getTurnLog().find((t) => t.turn_seq === d2Report.turnSeq);
		const d2StylizeFail = d2.eventRecords.filter((e) => e.role === "stylize" && e.ok === false && e.turnSeq === d2Report.turnSeq);
		console.log(`[obs] D2: stylize=${JSON.stringify(d2Report.stylize)} narrative==raw=${d2Report.narrativeText === d2TurnLog?.raw_text} stylize ok:false 记录=${d2StylizeFail.length}`);
		checks.push(check(`D2: applied=false（factCheck 拒绝）`, d2Report.stylize?.applied === false));
		checks.push(check("D2: narrative_text == raw_text（回退原文）", d2Report.narrativeText === (d2TurnLog?.raw_text ?? null)));
		checks.push(check(`D2: drift 记录非空（${JSON.stringify(d2Report.stylize?.drift ?? [])}）`, (d2Report.stylize?.drift?.length ?? 0) > 0));
		checks.push(check(`D2: eventLog 有 stylize ok:false 记录（${d2StylizeFail.length} 条）`, d2StylizeFail.length > 0));
		disposeBundle(d2);

		// ================= E. m4-cli 管道冒烟（story+npc；--stylize） =================
		console.log("\n===== E. m4-cli 管道冒烟 =====");
		const e1Root = join(root, "cli1");
		mkdirSync(e1Root, { recursive: true });
		const e1 = await runCliSmoke(e1Root, []);
		const e1StoryLine = e1.stdout.includes("--- story 阶段");
		console.log(`[obs] E1: exit=${e1.code} story 行=${e1StoryLine}`);
		if (e1.code !== 0) console.log(`[obs] E1 stderr: ${e1.stderr.slice(0, 300)}`);
		checks.push(check("E1: m4-cli（story+npc）冒烟 exit=0", e1.code === 0));
		checks.push(check("E1: m4-cli 输出含 story 阶段行", e1StoryLine));

		const e2Root = join(root, "cli2");
		mkdirSync(e2Root, { recursive: true });
		const e2 = await runCliSmoke(e2Root, ["--stylize", "--style", "古龙式短句"]);
		const e2StylizeLine = e2.stdout.includes("--- stylize");
		console.log(`[obs] E2: exit=${e2.code} stylize 行=${e2StylizeLine}`);
		if (e2.code !== 0) console.log(`[obs] E2 stderr: ${e2.stderr.slice(0, 300)}`);
		checks.push(check("E2: m4-cli --stylize 冒烟 exit=0", e2.code === 0));
		checks.push(check("E2: m4-cli --stylize 输出含 stylize 行", e2StylizeLine));

		console.log("\n===== M4 验收检查表 =====");
		printChecks(checks);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** 子进程跑 m4-cli：stdin 喂「一轮叙事 + 空行退出」，120s 超时保护。 */
function runCliSmoke(root: string, extraArgs: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const script = join(repoRoot, "packages/app/src/m4-cli.ts");
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, "--root", root, ...extraArgs], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			done({ code: -1, stdout, stderr: `${stderr}\n[timeout] m4-cli 冒烟超时被杀` });
		}, 120_000);
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? -1, stdout, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			done({ code: -1, stdout, stderr: `${stderr}\n${String(err)}` });
		});
		child.stdin.write("我举杯向梅姑致意。\n\n");
		child.stdin.end();
	});
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
