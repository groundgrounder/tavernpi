// M1-P3：§3.0 契约故事驱动集成验收（真实 LLM 轮次 + 真实 pi session 树 + core DB/快照接线）。
//
// 验收场景（创作规划 §3.0 / §7 M1）：
//   A. 回溯一致：navigateTree 回溯后 DB 与时钟 = 该节点快照态；
//   B. 回溯后再前进：跳转点写新分支后，navigateTree 前进到原主线 → DB 恢复原线状态，snapshots.db 不动；
//   C. fork 独立：pi fork 机制 + forkStoryDb 初始化新故事，写新事件后原故事 DB 不受影响；
//   边界（M0 遗留 m4）：不存在 entry 抛错且状态不变；isStreaming 中导航抛错；compaction 后导航进压缩区
//     恢复到被吞并 entry 保留的快照。
//
// 接线（m4 P3 契约）：
//   - persist pi session（mkdtemp）+ narrator.md 资源接管（08 范式）+ core openStoryDb/createDbTools/
//     createSnapshotHooks 注册到 extension；每轮：prompt → 模型 write_event/advance_clock → 记 turn_log →
//     takeSnapshot（绑定该轮 leaf assistant entry）。
//   - 快照绑定 = 该轮 leaf（assistant）entry id；hooks 用 before_tree 的 targetId 祖先链。
//   - 每次 navigateTree 后检查 lastRestoreResult；restoreSnapshot 消费旧 StoryDb（脚本经 getter 持有当前实例）。

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	buildAncestorChain,
	createDbTools,
	createSnapshotHooks,
	forkStoryDb,
	openSnapshotsDb,
	openStoryDb,
	snapshotsDbPath,
	takeSnapshot,
	type StoryClock,
	type StoryDb,
} from "@tavernpi/core";

// ---------------------------------------------------------------------------
// 固定资源与配置
// ---------------------------------------------------------------------------
const repoRoot = resolve(import.meta.dirname, "../../..");
const narratorContent = readFileSync(join(repoRoot, "packages/core/prompts/narrator.md"), "utf-8");

const APPEND = [
	"（M1 集成验收约定）保持简短：正文 1-2 句。",
	"每轮都必须用 write_event(summary, detail) 记录玩家行动产生的事件，并用 advance_clock(to_time) 推进故事时间。",
];

const SETTINGS = {
	defaultProvider: "deepseek",
	defaultModel: "deepseek-v4-flash",
	defaultThinkingLevel: "high",
	// spike 07 技巧：极小 keepRecentTokens 使短会话也能触发 compact（cut 在最末尾）。
	compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
} as const;

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
interface Check {
	label: string;
	pass: boolean;
	detail?: string;
}
const checks: Check[] = [];

function check(label: string, pass: boolean, detail?: string): void {
	checks.push({ label, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` —— ${detail}` : ""}`);
}

function captureDbState(story: StoryDb): {
	events: Array<{ id: number; turn_seq: number; summary: string }>;
	clock: StoryClock | null;
	timeLogCount: number;
	turnLogCount: number;
} {
	return {
		events: story.reader.listEvents().map((e) => ({ id: e.id, turn_seq: e.turn_seq, summary: e.summary })),
		clock: story.reader.getClock() ?? null,
		timeLogCount: story.reader.listTimeLog().length,
		turnLogCount: story.reader.getTurnLog().length,
	};
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

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
	const tmpRoot = mkdtempSync(join(tmpdir(), "tavernpi-m1p3-"));
	const sessionDir = join(tmpRoot, "sessions");
	const storiesRoot = join(tmpRoot, "stories");
	mkdirSync(sessionDir, { recursive: true });

	const sessionManager = SessionManager.create(repoRoot, sessionDir);
	const sessionId = sessionManager.getSessionId();
	const storyPath = join(storiesRoot, sessionId, "story.db");

	// ---- story.db + snapshots.db（hooks 构造需要，先于 createAgentSession） ----
	let current: StoryDb = openStoryDb(storyPath);
	const snapshotsDb = openSnapshotsDb(snapshotsDbPath(storyPath));
	console.log(`> sessionId: ${sessionId}`);
	console.log(`> story.db: ${storyPath}`);
	console.log(`> 工具白名单: [get_clock, query_events, get_npc, write_event, advance_clock]`);

	// 真实轮计数（注入 getCurrentTurnSeq）
	let currentTurn = 0;
	const dbTools = createDbTools(() => current, { getCurrentTurnSeq: () => currentTurn });

	// ---- 快照 hooks（getStoryDb/setStoryDb 走 current 引用；restoreSnapshot 消费旧句柄后回写） ----
	const hooks = createSnapshotHooks({
		snapshotsDb,
		getStoryDb: () => current,
		setStoryDb: (db) => {
			current = db;
		},
		getEntryAncestors: (entryId) => buildAncestorChain(sessionManager.getEntries(), entryId),
	});

	const extensionFactory = (pi: ExtensionAPI): void => {
		pi.on("session_before_tree", hooks.sessionBeforeTree);
		pi.on("session_tree", hooks.sessionTree);
		// 自定义压缩结果（跳过默认摘要 LLM 调用，spike 07 范式）
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "【M1-P3 自定义压缩摘要】此前的叙事已被压缩。",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				estimatedTokensAfter: 1,
			},
		}));
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
		appendSystemPromptOverride: () => APPEND,
		extensionFactories: [extensionFactory],
	});
	await loader.reload();

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: repoRoot,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ ...SETTINGS }),
		resourceLoader: loader,
		customTools: dbTools,
		tools: ["get_clock", "query_events", "get_npc", "write_event", "advance_clock"],
	});
	if (modelFallbackMessage) {
		console.error(`[warn] ${modelFallbackMessage}`);
	}

	// ------------------------------------------------------------------
	// 单轮：prompt → 记 turn_log（绑定 leaf）→ takeSnapshot（绑定该轮 leaf）
	// ------------------------------------------------------------------
	async function runTurn(userInput: string): Promise<{ leafId: string; reply: string }> {
		currentTurn += 1;
		const beforeCount = session.state.messages.length;
		await session.prompt(userInput);
		const newMessages = session.state.messages.slice(beforeCount);
		const reply = extractLastAssistantReply(newMessages) ?? "";
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) {
			throw new Error(`第 ${currentTurn} 轮结束后 leaf 为空`);
		}
		current.writer.recordTurnLog({ turnSeq: currentTurn, sessionEntryId: leafId, userInput, narrativeText: reply });
		await takeSnapshot(current, { turnSeq: currentTurn, sessionEntryId: leafId });
		console.log(`  [t${currentTurn}] leaf=${leafId.slice(0, 8)}… 回复=${reply.slice(0, 60)}`);
		return { leafId, reply };
	}

	// 断言 lastRestoreResult 并返回恢复轮次
	function assertRestoreOk(expectedTurnSeq: number | undefined, label: string): void {
		const r = hooks.state.lastRestoreResult;
		check(`[恢复] ${label}: lastRestoreResult.ok`, r?.ok === true, r?.ok === true ? undefined : `error=${r?.error}`);
		if (expectedTurnSeq !== undefined) {
			check(
				`[恢复] ${label}: restoredTurnSeq === ${expectedTurnSeq}`,
				r?.restoredTurnSeq === expectedTurnSeq,
				`got=${r?.restoredTurnSeq}`,
			);
		}
	}

	// 取 message 条目（user / assistant 交替）
	function messageEntries(role: "user" | "assistant"): Array<{ id: string; parentId: string | null }> {
		return session.sessionManager
			.getEntries()
			.filter((e) => e.type === "message" && (e.message as { role?: string }).role === role)
			.map((e) => ({ id: e.id, parentId: e.parentId }));
	}

	try {
		// ==================================================================
		// 主线 4 轮
		// ==================================================================
		console.log("\n===== 主线 4 轮 =====");
		const mainLine = [
			"主角推开城门，走进荒废的王城。用 write_event 记录这个事件，用 advance_clock 把时间推进到 0000-01-02。",
			"主角在庭院发现一口枯井。用 write_event 记录这个事件，用 advance_clock 把时间推进到 0000-01-03。",
			"主角在王座大厅发现壁炉余火未熄。用 write_event 记录这个事件，用 advance_clock 把时间推进到 0000-01-04。",
			"主角在藏宝室找到一把锈剑。用 write_event 记录这个事件，用 advance_clock 把时间推进到 0000-01-05。",
		];
		const [t1, t2, t3, t4] = mainLine;
		if (!t1 || !t2 || !t3 || !t4) {
			throw new Error("主线输入缺失");
		}
		await runTurn(t1);
		const s1Ref = captureDbState(current); // 第 1 轮末参考态
		await runTurn(t2);
		const s2Ref = captureDbState(current); // 第 2 轮末参考态
		await runTurn(t3);
		await runTurn(t4);
		const s4Ref = captureDbState(current); // 第 4 轮末参考态

		const users = messageEntries("user");
		const [u1, u2] = users;
		if (!u1 || !u2) {
			throw new Error("未收集到第 1/2 轮 user 条目");
		}
		// 快照绑定 = 该轮 leaf（最终 assistant）entry（m4 契约）。
		// 工具调用轮会产出多条 assistant 消息，因此「第 N 轮末」目标取快照绑定的 leaf id。
		const leafIdOf = (turnSeq: number): string => {
			const row = snapshotsDb.listSnapshots().find((s) => s.turn_seq === turnSeq);
			if (!row) {
				throw new Error(`未找到第 ${turnSeq} 轮快照`);
			}
			return row.session_entry_id;
		};
		const a2Leaf = leafIdOf(2);
		const a3Leaf = leafIdOf(3);
		const a4Leaf = leafIdOf(4);
		console.log(`> 主线条目: u1=${u1.id.slice(0, 8)}… u2=${u2.id.slice(0, 8)}… a2Leaf=${a2Leaf.slice(0, 8)}… a4Leaf=${a4Leaf.slice(0, 8)}…`);

		check("主线 4 轮后事件 ≥ 2（模型真实调用 write_event）", s4Ref.events.length >= 2, `events=${s4Ref.events.length}`);
		check(
			"主线 4 轮后时钟已推进（模型真实调用 advance_clock）",
			s4Ref.clock !== null && s4Ref.clock.current_time !== "0000-01-01",
			`clock=${s4Ref.clock?.current_time}`,
		);
		check("主线 4 轮后 snapshots ≥ 4", snapshotsDb.listSnapshots().length >= 4, `snapshots=${snapshotsDb.listSnapshots().length}`);

		// ==================================================================
		// 场景 A：回溯一致
		// ==================================================================
		console.log("\n===== 场景 A：回溯一致 =====");
		// A1：回溯到第 2 轮 user entry（u2）→ 落点 = u2.parentId（a1，第 1 轮末），DB 应 = 第 1 轮末参考态。
		await session.navigateTree(u2.id);
		assertRestoreOk(1, "A1 回溯到 u2（落点 a1 = 第 1 轮末）");
		const stateAtA1 = captureDbState(current);
		check(
			"A1 当前 DB events/clock 与第 1 轮末一致",
			JSON.stringify(stateAtA1.events) === JSON.stringify(s1Ref.events) &&
				JSON.stringify(stateAtA1.clock) === JSON.stringify(s1Ref.clock),
			`events=${stateAtA1.events.length} clock=${stateAtA1.clock?.current_time}`,
		);

		// A2：回溯到第 2 轮末（leaf a2Leaf）→ DB 与第 2 轮末一致（s2Ref 在第 2 轮末记录）。
		await session.navigateTree(a2Leaf);
		assertRestoreOk(2, "A2 回溯到 a2（第 2 轮末）");
		const stateAtA2 = captureDbState(current);
		check(
			"A2 当前 DB events/clock 与第 2 轮末一致",
			JSON.stringify(stateAtA2.events) === JSON.stringify(s2Ref.events) &&
				JSON.stringify(stateAtA2.clock) === JSON.stringify(s2Ref.clock),
			`events=${stateAtA2.events.length} clock=${stateAtA2.clock?.current_time}`,
		);

		// ==================================================================
		// 场景 B：回溯后再前进
		// ==================================================================
		console.log("\n===== 场景 B：回溯后再前进 =====");
		const branchLine = [
			"主角决定重返庭院调查枯井。用 write_event 记录这个事件，用 advance_clock 把时间推进到 0000-01-06。",
			"主角在井底发现一条密道。用 write_event 记录这个事件，用 advance_clock 把时间推进到 0000-01-07。",
		];
		for (const prompt of branchLine) {
			await runTurn(prompt);
		}
		const branchEvents = captureDbState(current).events.length;
		check("分支 2 轮正常落库（事件增加）", branchEvents === s2Ref.events.length + 2, `events=${branchEvents}`);
		check(
			"分支 2 轮正常拍快照",
			snapshotsDb.listSnapshots().length >= 6,
			`snapshots=${snapshotsDb.listSnapshots().length}`,
		);

		// 前进回原主线第 4 轮（a4）→ 恢复到 S4；snapshots.db 不动、晚快照仍可用。
		const snapCountBefore = snapshotsDb.listSnapshots().length;
		await session.navigateTree(a4Leaf);
		assertRestoreOk(4, "B 前进到 a4（原主线第 4 轮）");
		const stateAtA4 = captureDbState(current);
		check(
			"B 当前 DB = 原主线第 4 轮状态（S4）",
			JSON.stringify(stateAtA4.events) === JSON.stringify(s4Ref.events) &&
				JSON.stringify(stateAtA4.clock) === JSON.stringify(s4Ref.clock),
			`events=${stateAtA4.events.length} clock=${stateAtA4.clock?.current_time}`,
		);
		check(
			"B snapshots.db 不动（晚快照仍可用）",
			snapshotsDb.listSnapshots().length === snapCountBefore,
			`snapshots=${snapshotsDb.listSnapshots().length}`,
		);

		// ==================================================================
		// 场景 C：fork 独立
		// ==================================================================
		console.log("\n===== 场景 C：fork 独立 =====");
		const forkSessionFile = sessionManager.createBranchedSession(a3Leaf);
		check("pi fork 机制创建新 session 文件", typeof forkSessionFile === "string" && forkSessionFile.length > 0, forkSessionFile);
		const forkDir = join(tmpRoot, "fork-story");
		const ancestorsOfA3 = buildAncestorChain(sessionManager.getEntries(), a3Leaf);
		const fork = forkStoryDb(snapshotsDb, ancestorsOfA3, forkDir);
		check("fork 新库 = 第 3 轮快照态（3 事件）", fork.storyDb.reader.listEvents().length === 3, `events=${fork.storyDb.reader.listEvents().length}`);
		check("fork snapshots.db 仅 1 份快照", fork.snapshotsDb.listSnapshots().length === 1);

		const srcBefore = captureDbState(current);
		fork.storyDb.writer.insertEvent({ turnSeq: 10, summary: "fork 分支新事件：主角在井底拾到一枚古戒" });
		check("向 fork 写新事件成功", fork.storyDb.reader.listEvents().length === 4);
		const srcAfter = captureDbState(current);
		check(
			"原故事 DB 不受影响",
			JSON.stringify(srcAfter.events) === JSON.stringify(srcBefore.events) &&
				JSON.stringify(srcAfter.clock) === JSON.stringify(srcBefore.clock),
		);
		fork.storyDb.close();
		fork.snapshotsDb.close();

		// ==================================================================
		// 边界：不存在 entry / isStreaming / compaction
		// ==================================================================
		console.log("\n===== 边界实证 =====");
		// 不存在 entry id → 抛错且状态不变
		const leafBeforeGhost = session.sessionManager.getLeafId();
		let ghostThrew = false;
		try {
			await session.navigateTree("ghost-entry-id");
		} catch (err) {
			ghostThrew = err instanceof Error && err.message.includes("Entry ghost-entry-id not found");
		}
		check("导航不存在 entry 抛错（Entry ... not found）", ghostThrew);
		check("抛错后叶子不变", session.sessionManager.getLeafId() === leafBeforeGhost);

		// isStreaming 中导航 → 抛错（session.subscribe 监听 agent_start，在 agent 运行中尝试导航）
		let streamingNavError: string | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") {
				session.navigateTree(a4Leaf).then(
					() => {
						streamingNavError = "no-throw";
					},
					(err: unknown) => {
						streamingNavError = err instanceof Error ? err.message : String(err);
					},
				);
			}
		});
		await session.prompt("请用一句话确认当前进度。不要调用任何工具。");
		await new Promise((r) => setTimeout(r, 200));
		unsubscribe();
		check(
			"isStreaming 中导航抛错",
			streamingNavError !== undefined && streamingNavError.includes("Wait for the current response"),
			streamingNavError,
		);

		// compaction 后导航进压缩区 → 恢复到被吞并 entry 保留的快照
		await session.compact();
		await session.navigateTree(a2Leaf);
		assertRestoreOk(2, "压缩区导航（被吞并 entry a2 的快照仍保留）");
		const stateAfterCompactNav = captureDbState(current);
		check(
			"压缩区导航后 DB = 第 2 轮末（被吞并快照）",
			JSON.stringify(stateAfterCompactNav.events) === JSON.stringify(s2Ref.events),
			`events=${stateAfterCompactNav.events.length}`,
		);

		// ==================================================================
		// 检查表
		// ==================================================================
		const failed = checks.filter((c) => !c.pass);
		console.log(`\n===== M1-P3 集成验收检查表（${checks.length - failed.length}/${checks.length} 通过） =====`);
		for (const c of checks) {
			console.log(`[${c.pass ? "✓" : "✗"}] ${c.label}${c.detail ? ` —— ${c.detail}` : ""}`);
		}
		console.log(`===== 结果: ${failed.length === 0 ? "PASS" : "FAIL"} =====`);
		if (failed.length > 0) {
			process.exitCode = 1;
		}
	} finally {
		session.dispose();
		snapshotsDb.close();
		if (current && current !== undefined) {
			try {
				current.close();
			} catch {
				// 可能已被 dispose/恢复消费
			}
		}
		rmSync(tmpRoot, { recursive: true, force: true });
		console.log(`\n> 已清理临时目录: ${tmpRoot}`);
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
