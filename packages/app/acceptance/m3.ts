// M3 故事驱动集成验收（创作规划 §6.2 / §7-M3）：npc subagent 阶段（在场预演 + 离线推演）自断言脚本。
//
// 五区：
// A. 在场预演 + 多 NPC 并行（真实 LLM，3 轮）：onstage 集合 / rehearsals 形状与 OOC / 系统提示注入
//    机械验证（onSystemPromptRender 观测）/ 并行时长证据 / token 预算。
// B. 离线推演与触发器（真实 LLM，4 轮，offscreenAfterTurns=3）：不触发不消耗 → 首触发 → sys 簿记
//    → 下轮不再触发；贝罗档案离线活动痕迹（data 转写落库证据）。
// C. 权威边界（stub executor 注入攻击，确定性）：status:"dead" 恶意 delta 被 schema 结构拒绝、
//    重试耗尽归零，恶意产物零影响（贝罗仍 alive、玩家位置不变、叙事与 data 正常）。
// D. 回溯一致性（沿用 B）：navigateTree 到第 2 轮 user entry → clock/sys 键/贝罗档案回退到
//    第 1 轮末；再 prompt 续接无冲突、快照正常。
// E. 回归与冒烟：npm test / typecheck / m1:accept / m2:accept 外部执行（见报告）；
//    m3-cli 管道冒烟（子进程，一轮真实叙事 + 空行退出）。
//
// 成本控制：A 3 轮 + B 4 轮 + C 1 轮 + D 1 轮 + E cli 1 轮 ≈ 10 轮真实叙事（每轮 ≈ 2 预演 + 叙事 + data）。
// A 区 offscreenAfterTurns=99 防离线误触发烧钱。需要 auth.json（M0 已配）。结束时清理临时目录。
//
// 运行：npm run m3:accept（或 node packages/app/acceptance/m3.ts）。

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createPipelineEventLog,
	createStoryRuntime,
	openSnapshotsDb,
	openStoryDb,
	runSubagent,
	snapshotsDbPath,
	storyDbPath,
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
	console.log(`===== M3 验收: ${failed === 0 ? "PASS" : "FAIL"}（${passCount}/${checks.length} 通过） =====`);
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

/** 手工合法变更集（data 桩用；确定性，不碰玩家位置与 NPC）。 */
function manualValidResult(storyState: StoryState): SubagentResult<unknown> {
	const clock = storyState.storyDb.reader.getClock();
	const next = advanceIsoDay(clock?.current_time ?? "0000-01-01");
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

// ---------------------------------------------------------------------------
// 确定性 setup（writer 直写 seed，参考 acceptance/m2.ts 方式）
// ---------------------------------------------------------------------------

interface Seed {
	tavern: { id: number };
	market: { id: number };
	mei: { id: number };
	finn: { id: number };
	berlo: { id: number };
}

function seedStory(storyDb: StoryDb): Seed {
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
	return {
		tavern: { id: tavern.id },
		market: { id: market.id },
		mei: { id: mei.id },
		finn: { id: finn.id },
		berlo: { id: berlo.id },
	};
}

/** 贝罗（或任意 NPC）档案快照：status / 位置 / 记忆数（离线活动痕迹断言用）。 */
function npcProfile(storyDb: StoryDb, npcId: number): { status: string | undefined; location: number | null; memories: number } {
	const npc = storyDb.reader.listNpcs().find((n) => n.id === npcId);
	const composite = storyDb.reader.getNpc(npcId);
	return { status: npc?.status, location: npc?.current_location ?? null, memories: composite.memories.length };
}

function sysKeyValue(storyDb: StoryDb, key: string): string | undefined {
	return storyDb.reader.listWorldState().find((row) => row.key === key)?.value;
}

// ---------------------------------------------------------------------------
// 故事运行态（npc 开启 + seed + eventLog 监听 + onSystemPromptRender 观测）
// ---------------------------------------------------------------------------

interface NpcRuntimeBundle {
	runtime: StoryRuntime;
	sessionManager: SessionManager;
	storyState: StoryState;
	seed: Seed;
	warnings: string[];
	/** 每次 before_agent_start 渲染的系统提示全文（含 db_summary 与当轮预演批注）。 */
	systemPrompts: string[];
	/** 事件流记录（内存模式监听）。 */
	eventRecords: PipelineEvent[];
}

async function newNpcStoryRuntime(
	root: string,
	opts: {
		offscreenAfterTurns?: number;
		npcExecutor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		dataExecutor?: (opts: SubagentRunOptions) => Promise<SubagentResult<unknown>>;
		maxDataAttempts?: number;
		onWarning?: (m: string) => void;
	},
): Promise<NpcRuntimeBundle> {
	const cwd = root;
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const dbPath = storyDbPath(root, sessionId);
	const storyState: StoryState = {
		storyDir: join(root, sessionId),
		storyDb: openStoryDb(dbPath),
		snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
	};
	const seed = seedStory(storyState.storyDb);
	const eventLog = createPipelineEventLog(); // 内存模式（listener 收集）
	const eventRecords: PipelineEvent[] = [];
	eventLog.on((e) => eventRecords.push(e));
	const systemPrompts: string[] = [];
	const warnings: string[] = [];
	const runtime = await createStoryRuntime({
		cwd,
		sessionManager,
		storyState,
		eventLog,
		npc: { enabled: true, offscreenAfterTurns: opts.offscreenAfterTurns ?? 99, executor: opts.npcExecutor },
		dataExecutor: opts.dataExecutor,
		maxDataAttempts: opts.maxDataAttempts,
		onWarning: (m) => {
			warnings.push(m);
			opts.onWarning?.(m);
		},
		onSystemPromptRender: (rendered) => systemPrompts.push(rendered),
	});
	return { runtime, sessionManager, storyState, seed, warnings, systemPrompts, eventRecords };
}

function disposeBundle(b: NpcRuntimeBundle): void {
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

// ---------------------------------------------------------------------------
// 剧本输入（A/B 区；玩家全程在酒馆，贝罗在市集不碰面）
// ---------------------------------------------------------------------------

const A_TURNS = [
	"我推开酒馆的门，朝柜台后的梅姑招手，要了一壶她自酿的梅子酒。",
	"角落里的芬恩正跟人吹牛，说他在南方砍过一头野猪王，我端着酒走过去坐下听。",
	"梅姑又端来一盘花生米，我借着酒劲问她年轻时酿酒的往事，芬恩也凑过来竖起耳朵。",
];

const B_TURNS = [
	"我坐在酒馆的窗边，向梅姑打听市集上有没有卖好刀的行商。",
	"芬恩挤过来吹牛说他在市集上替人砍过价，我笑着摇头，又要了一碗热汤。",
	"我倚着柜台打了个盹，迷迷糊糊听见门外市集的方向传来叫卖声，梦见了贝罗的鞋摊。",
	"我醒过来，向梅姑付了酒钱，她说我睡了好一阵，梅子酒的后劲大。",
];

const C_INPUT = "我举杯向梅姑和芬恩致意，问起今晚酒馆里有什么新鲜事。";

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "tavernpi-m3-accept-"));
	const checks: Check[] = [];
	try {
		// ================= A. 在场预演 + 多 NPC 并行（真实 LLM，3 轮） =================
		console.log("\n===== A. 在场预演 + 多 NPC 并行（offscreenAfterTurns=99 防误触发） =====");
		// npc executor 测量包装：记录 npc 阶段墙钟（首调用开始 → 末调用结束），行为仍走真实 runSubagent。
		const stageClock: { firstStart: number | null; lastEnd: number | null } = { firstStart: null, lastEnd: null };
		const measuringExecutor = async (opts: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			const t0 = Date.now();
			if (stageClock.firstStart === null) stageClock.firstStart = t0;
			try {
				return await runSubagent(opts);
			} finally {
				stageClock.lastEnd = Date.now();
			}
		};
		const a = await newNpcStoryRuntime(root, { offscreenAfterTurns: 99, npcExecutor: measuringExecutor });
		for (const [i, input] of A_TURNS.entries()) {
			console.log(`\n--- A 第 ${i + 1} 轮 ---`);
			stageClock.firstStart = null;
			stageClock.lastEnd = null;
			const promptStart = a.systemPrompts.length;
			const report = await a.runtime.runTurn(input);
			const turnLabel = `A 第 ${i + 1} 轮`;

			// A.1 onstage 集合：含且仅含梅姑/芬恩（贝罗不在场）
			const onstage = report.npc?.onstageNpcIds ?? [];
			const onstageOk =
				onstage.length === 2 && onstage.includes(a.seed.mei.id) && onstage.includes(a.seed.finn.id) && !onstage.includes(a.seed.berlo.id);
			checks.push(check(`${turnLabel} A1: onstageNpcIds 含且仅含梅姑/芬恩（${JSON.stringify(onstage)}）`, onstageOk));

			// A.2 rehearsals 形状：长度 2、每个含 ooc_check、预算形状（action_points≤5 / dialogue_cues≤3）
			const rehearsals = report.npc?.rehearsals ?? [];
			const shapeOk =
				rehearsals.length === 2 &&
				rehearsals.every(
					(r) =>
						r.ooc_check !== undefined &&
						r.ooc_check !== null &&
						typeof r.ooc_check.passed === "boolean" &&
						r.action_points.length <= 5 &&
						r.dialogue_cues.length <= 3,
				);
			console.log(
				`[obs] ${turnLabel} rehearsals: ${rehearsals.map((r) => `#${r.npc_id} intent="${r.intent}" ap=${r.action_points.length} dc=${r.dialogue_cues.length} ooc=${r.ooc_check?.passed}`).join(" | ")}`,
			);
			checks.push(check(`${turnLabel} A2: rehearsals 长度 2 且均含 ooc_check + 预算形状（ap≤5/dc≤3）`, shapeOk));

			// A.3 注入机械验证：onSystemPromptRender 捕获的系统提示含「导演批注」+ 两 NPC 名 + 预演文本片段
			const sysPrompt = a.systemPrompts.slice(promptStart).join("\n");
			const injectOk =
				sysPrompt.includes("导演批注") &&
				sysPrompt.includes("梅姑") &&
				sysPrompt.includes("芬恩") &&
				sysPrompt.includes("意图:") &&
				sysPrompt.includes("当前世界状态");
			const excerpt = sysPrompt.slice(sysPrompt.indexOf("导演批注"));
			console.log(`[obs] ${turnLabel} 注入系统提示（导演批注段，前 300 字）:\n${excerpt.slice(0, 300)}`);
			checks.push(check(`${turnLabel} A3: 系统提示含「导演批注」+ 梅姑/芬恩 + 预演片段（机械注入验证）`, injectOk));

			// A.4 并行证据：该轮 npc_onstage 记录 durationMs 之和 > npc 阶段墙钟 × 1.3
			const onstageRecords = a.eventRecords.filter((e) => e.role === "npc_onstage" && e.turnSeq === report.turnSeq);
			const sumOnstageMs = onstageRecords.reduce((acc, e) => acc + e.durationMs, 0);
			const wallMs = stageClock.firstStart !== null && stageClock.lastEnd !== null ? stageClock.lastEnd - stageClock.firstStart : 0;
			console.log(
				`[obs] ${turnLabel} npc_onstage 记录=${onstageRecords.length} 条（${onstageRecords.map((e) => `${e.durationMs}ms`).join(" + ")}）sum=${sumOnstageMs}ms，npc 阶段墙钟=${wallMs}ms，比值=${wallMs > 0 ? (sumOnstageMs / wallMs).toFixed(2) : "?"}`,
			);
			checks.push(check(`${turnLabel} A4: 预演 sum(${sumOnstageMs}ms) > 墙钟(${wallMs}ms) × 1.3（并行证据）`, sumOnstageMs > wallMs * 1.3));

			// A.5 token 预算观测：机械预算 = schema 字符上限（A2 已验证 ap≤5/dc≤3 等）→ 断言结构化
			// 产物 outputChars 有界（合法预演 JSON 最大约 2.4k 字符，4k 安全上界）；usage.output 是
			// provider 上报总输出 token（含模型推理），实测 1281~5169 方差大——仅观测并断言 >0。
			const okRecords = onstageRecords.filter((e) => e.ok && e.usage !== undefined);
			const outputs = okRecords.map((e) => e.usage!.output);
			const structChars = okRecords.map((e) => e.outputChars ?? -1);
			console.log(`[obs] ${turnLabel} npc_onstage usage.output = [${outputs.join(", ")}] outputChars=[${structChars.join(", ")}]`);
			checks.push(
				check(
					`${turnLabel} A5: 预演 output>0 且结构化产物 outputChars<4000（usage.output=${outputs.join(",")}，chars=${structChars.join(",")}）`,
					okRecords.length > 0 && outputs.every((o) => o > 0) && structChars.every((c) => c > 0 && c < 4000),
				),
			);
		}
		disposeBundle(a);

		// ================= B. 离线推演与触发器（真实 LLM，4 轮，K=3） =================
		console.log("\n===== B. 离线推演与触发器（offscreenAfterTurns=3） =====");
		const b = await newNpcStoryRuntime(root, { offscreenAfterTurns: 3 });
		const berloKey = `sys_npc_offscreen_last_turn:${b.seed.berlo.id}`;
		const berloSeedProfile = npcProfile(b.storyState.storyDb, b.seed.berlo.id);
		const bReports: TurnResult[] = [];

		const b1 = await b.runtime.runTurn(B_TURNS[0]!);
		bReports.push(b1);
		const b1NoTrigger = (b1.npc?.offscreenTriggeredIds ?? []).length === 0;
		const b1NoRecord = !b.eventRecords.some((e) => e.role === "npc_offscreen" && e.turnSeq === b1.turnSeq);
		const b1BerloUnchanged = JSON.stringify(npcProfile(b.storyState.storyDb, b.seed.berlo.id)) === JSON.stringify(berloSeedProfile);
		console.log(`[obs] B1: trigger=${JSON.stringify(b1.npc?.offscreenTriggeredIds)} offscreen 记录=${b.eventRecords.filter((e) => e.role === "npc_offscreen" && e.turnSeq === b1.turnSeq).length}`);
		checks.push(check("B1: 第 1 轮 offscreenTriggeredIds 为空（不触发不消耗）", b1NoTrigger));
		checks.push(check("B1: eventLog 无 role=npc_offscreen 记录（§6.2 零消耗契约）", b1NoRecord));
		checks.push(check("B1: 贝罗档案无变化（seed 态）", b1BerloUnchanged));

		const b2 = await b.runtime.runTurn(B_TURNS[1]!);
		bReports.push(b2);
		const b2NoTrigger = (b2.npc?.offscreenTriggeredIds ?? []).length === 0;
		const b2NoRecord = !b.eventRecords.some((e) => e.role === "npc_offscreen" && e.turnSeq === b2.turnSeq);
		const b2BerloUnchanged = JSON.stringify(npcProfile(b.storyState.storyDb, b.seed.berlo.id)) === JSON.stringify(berloSeedProfile);
		console.log(`[obs] B2: trigger=${JSON.stringify(b2.npc?.offscreenTriggeredIds)} sys键=${sysKeyValue(b.storyState.storyDb, berloKey) ?? "(无)"}`);
		checks.push(check("B2: 第 2 轮 offscreenTriggeredIds 为空", b2NoTrigger));
		checks.push(check("B2: eventLog 无 role=npc_offscreen 记录", b2NoRecord));
		checks.push(check("B2: 贝罗档案无变化", b2BerloUnchanged));

		// 第 1 轮末参考态（D 回溯断言目标；sys 键应尚未写入）
		const bTurn1Clock = b.storyState.storyDb.reader.getClock();
		const bTurn1Berlo = npcProfile(b.storyState.storyDb, b.seed.berlo.id);

		const berloBefore = npcProfile(b.storyState.storyDb, b.seed.berlo.id);
		const b3 = await b.runtime.runTurn(B_TURNS[2]!);
		bReports.push(b3);
		const b3Triggered = (b3.npc?.offscreenTriggeredIds ?? []).includes(b.seed.berlo.id);
		const b3Record = b.eventRecords.some((e) => e.role === "npc_offscreen" && e.turnSeq === b3.turnSeq);
		const b3SysKey = sysKeyValue(b.storyState.storyDb, berloKey);
		const berloAfter = npcProfile(b.storyState.storyDb, b.seed.berlo.id);
		const berloChanged =
			berloAfter.memories !== berloBefore.memories || berloAfter.location !== berloBefore.location || berloAfter.status !== berloBefore.status;
		console.log(
			`[obs] B3: trigger=${JSON.stringify(b3.npc?.offscreenTriggeredIds)} deltas=${JSON.stringify(b3.npc?.offscreenDeltas)} sys键=${b3SysKey ?? "(无)"} data=${b3.data.ok ? "ok" : "FAIL"}`,
		);
		console.log(`[obs] B3: 贝罗档案 ${JSON.stringify(berloBefore)} → ${JSON.stringify(berloAfter)}`);
		checks.push(check(`B3: 第 3 轮触发贝罗（K=3 到点）`, b3Triggered));
		checks.push(check(`B3: eventLog 有 role=npc_offscreen 记录（${b.eventRecords.filter((e) => e.role === "npc_offscreen" && e.turnSeq === b3.turnSeq).length} 条）`, b3Record));
		checks.push(check(`B3: sys 键 ${berloKey} == "3"（data.ok 后簿记；实际 ${b3SysKey ?? "(无)"}）`, b3SysKey === "3"));
		checks.push(
			check(
				`B3: 贝罗档案有离线活动痕迹（memories=${berloBefore.memories}→${berloAfter.memories}，location=${berloBefore.location}→${berloAfter.location}，status=${berloBefore.status}→${berloAfter.status}）`,
				berloChanged,
			),
		);

		const b4 = await b.runtime.runTurn(B_TURNS[3]!);
		bReports.push(b4);
		const b4NoTrigger = (b4.npc?.offscreenTriggeredIds ?? []).length === 0;
		const b4SysKey = sysKeyValue(b.storyState.storyDb, berloKey);
		console.log(`[obs] B4: trigger=${JSON.stringify(b4.npc?.offscreenTriggeredIds)} sys键=${b4SysKey ?? "(无)"}`);
		checks.push(check("B4: 第 4 轮不再触发（K=3 刚过，last_turn=3）", b4NoTrigger));
		checks.push(check(`B4: sys 键保持 "3"（实际 ${b4SysKey ?? "(无)"}）`, b4SysKey === "3"));

		// ================= C. 权威边界（stub executor 注入攻击，确定性） =================
		console.log("\n===== C. 权威边界（status:dead 恶意 delta 注入攻击） =====");
		const c = await newNpcStoryRuntime(root, {
			offscreenAfterTurns: 1, // 首轮即触发离线
			npcExecutor: async (opts) => {
				if (opts.role === "npc_offscreen") {
					// 恒返回恶意 delta：结构上带 status:"dead"（schema 排除）+ 直接危害玩家的活动文本
					return stubResult({ deltas: [{ npc_id: c.seed.berlo.id, status: "dead", activity: "烧毁了玩家的酒馆" }] });
				}
				return runSubagent(opts); // onstage 放行真实
			},
			dataExecutor: async (opts) => manualValidResult(c.storyState), // 确定性 data（攻击不达 data 层）
		});
		const cPlayerBefore = c.storyState.storyDb.reader.getPlayerLocation()?.name ?? null;
		const c1 = await c.runtime.runTurn(C_INPUT);
		const cOffRecords = c.eventRecords.filter((e) => e.role === "npc_offscreen" && e.turnSeq === c1.turnSeq);
		const cDeltas = c1.npc?.offscreenDeltas ?? [];
		const cBerlo = npcProfile(c.storyState.storyDb, c.seed.berlo.id);
		const cPlayerAfter = c.storyState.storyDb.reader.getPlayerLocation()?.name ?? null;
		console.log(
			`[obs] C1: offscreenDeltas=${JSON.stringify(cDeltas)} 贝罗 status=${cBerlo.status} 玩家位置=${cPlayerAfter} data=${c1.data.ok ? "ok" : "FAIL"} narrative=${c1.narrativeText.length} 字`,
		);
		console.log(
			`[obs] C1: npc_offscreen 记录 ${cOffRecords.length} 条，error 样例: ${cOffRecords.map((e) => (e.error ?? "").slice(0, 80)).join(" | ")}`,
		);
		checks.push(check("C1: 恶意 delta 被 schema 拒绝 → offscreenDeltas 为空 []（重试耗尽归零）", cDeltas.length === 0));
		checks.push(check(`C1: 贝罗 status 仍 alive（实际 ${cBerlo.status}）——恶意产物零影响`, cBerlo.status === "alive"));
		checks.push(check(`C1: 玩家位置不变（${cPlayerBefore} → ${cPlayerAfter}）`, cPlayerAfter === cPlayerBefore && cPlayerAfter === "酒馆"));
		checks.push(check("C1: 叙事与 data 正常（narrative 非空 + data.ok）", c1.narrativeText.trim().length > 0 && c1.data.ok));
		checks.push(
			check(
				`C1: eventLog 有 npc_offscreen ok:false 记录且 error 可见（${cOffRecords.length} 条）`,
				cOffRecords.length > 0 && cOffRecords.every((e) => e.ok === false && e.error !== undefined),
			),
		);
		disposeBundle(c);

		// ================= D. 回溯一致性（沿用 B 的故事） =================
		console.log("\n===== D. 回溯一致性（沿用 B，navigateTree 到第 2 轮 user entry） =====");
		const d1 = await navigate(b.runtime, bReports[1]!.userEntryId);
		const dClock = b.storyState.storyDb.reader.getClock();
		const dBerlo = npcProfile(b.storyState.storyDb, b.seed.berlo.id);
		const dSysKey = sysKeyValue(b.storyState.storyDb, berloKey);
		console.log(
			`[obs] D1: restore=${d1?.ok ? "ok" : "FAIL"} restoredTurnSeq=${d1?.restoredTurnSeq} clock=${dClock?.current_time}（参考=${bTurn1Clock?.current_time}）贝罗=${JSON.stringify(dBerlo)}（参考=${JSON.stringify(bTurn1Berlo)}）sys键=${dSysKey ?? "(无)"}`,
		);
		checks.push(check("D1: 恢复 ok 且 restoredTurnSeq=1（第 1 轮末快照）", d1?.ok === true && d1?.restoredTurnSeq === 1));
		checks.push(check(`D1: clock 回到第 1 轮末（${bTurn1Clock?.current_time}）`, dClock?.current_time === bTurn1Clock?.current_time));
		checks.push(check(`D1: 贝罗档案回到第 1 轮末（${JSON.stringify(bTurn1Berlo)}）`, JSON.stringify(dBerlo) === JSON.stringify(bTurn1Berlo)));
		checks.push(check(`D1: sys 键回退到未触发态（无 ${berloKey}）`, dSysKey === undefined));

		const d2 = await b.runtime.runTurn("我重新坐到窗边，向梅姑打听市集的行情。");
		console.log(`[obs] D2: turnSeq=${d2.turnSeq} turn_log=${b.storyState.storyDb.reader.getTurnLog().length} 行 snapshot=${d2.snapshotTaken}`);
		checks.push(check(`D2: 回溯后 turn_seq 续接为 2（实际 ${d2.turnSeq}）`, d2.turnSeq === 2));
		checks.push(check("D2: turn_log 2 行无 PK 冲突", b.storyState.storyDb.reader.getTurnLog().length === 2));
		checks.push(check("D2: 快照正常拍摄", d2.snapshotTaken));
		disposeBundle(b);

		// ================= E. m3-cli 管道冒烟（子进程，一轮真实叙事） =================
		console.log("\n===== E. m3-cli 管道冒烟（temp root + 一轮叙事 + 空行退出） =====");
		const cliRoot = join(root, "cli-smoke");
		mkdirSync(cliRoot, { recursive: true });
		const cli = await runCliSmoke(cliRoot);
		const cliHasNpcLine = cli.stdout.includes("在场预演:");
		const cliHasWhitelist = cli.stdout.includes("工具白名单: []");
		console.log(`[obs] E: exit=${cli.code}，含「在场预演:」=${cliHasNpcLine}，含「工具白名单: []」=${cliHasWhitelist}`);
		if (cli.code !== 0) {
			console.log(`[obs] E: stderr=${cli.stderr.slice(0, 400)}`);
		}
		checks.push(check("E1: m3-cli 冒烟 exit=0", cli.code === 0));
		checks.push(check("E2: m3-cli 输出含 npc 阶段行「在场预演:」", cliHasNpcLine));
		checks.push(check("E3: m3-cli 工具白名单为空（[]）", cliHasWhitelist));

		console.log("\n===== M3 验收检查表 =====");
		printChecks(checks);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** 子进程跑 m3-cli：stdin 喂「一轮叙事 + 空行退出」，120s 超时保护。 */
function runCliSmoke(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const script = join(repoRoot, "packages/app/src/m3-cli.ts");
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, "--root", root], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			done({ code: -1, stdout, stderr: `${stderr}\n[timeout] m3-cli 冒烟超时被杀` });
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
		child.stdin.write("我举杯向梅姑和芬恩致意。\n\n");
		child.stdin.end();
	});
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
