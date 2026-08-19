// M1 故事驱动集成验收（创作规划 §7-M1 / §3.0 契约）：自断言脚本，exit code 正确。
//
// 三场景（快照绑定 = 本轮 assistant leaf，与 turn_log 同一 id；Reconciliation 已裁决）：
// 1. 回溯一致：固定 3 轮输入（每轮强引导模型 write_event + advance_clock）→ navigateTree 回
//    第 2 轮 user entry u2 → DB/clock/turn_log 回到第 1 轮末参考态（重做第 2 轮的一致状态）；
//    再 navigateTree 回第 1 轮 user entry u1 → 链上无快照 → 空库兜底 = 故事初始态。
// 2. 回溯后再前进：navigateTree 到第 3 轮 assistant leaf a3 → DB 回到第 3 轮后状态，
//    snapshots.db 行数不变（晚于目标的快照保留，§3.1）。
// 3. fork 独立：从第 2 轮末 assistant leaf（a2）fork（clone/at 语义，分支内容含到 a2 为止）→
//    新 sessionId ≠ 旧；新故事 story.db == 第 2 轮后状态、新 snapshots.db 仅 1 份且绑定 a2；
//    在新故事再跑 1 轮 → 旧故事两库逐行不变、新故事含新事件。
//
// 复用 m1-cli.ts 的 buildM1Runtime / runM1Turn / navigateToEntry（CLI 即 API 参照实现，§10.2）。
// 需要 auth.json（M0 已配）；模型每轮不调工具 = FAIL（检查表风格，参照 M0 demo printChecklist）。
//
// 运行：npm run m1:accept（或 node packages/app/acceptance/m1.ts）。结束时清理临时目录。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildAncestorChain,
	DEFAULT_STORY_CLOCK,
	forkStoryDb,
	openSnapshotsDb,
	openStoryDb,
	snapshotsDbPath,
	storyDbPath as coreStoryDbPath,
} from "@tavernpi/core";
import {
	buildM1Runtime,
	computeNextTurnSeq,
	navigateToEntry,
	runM1Turn,
	type M1StoryState,
	type TurnReport,
} from "../src/m1-cli.ts";

const ACCEPTANCE_TURNS = [
	"主角推开王城大门，暮色正沉。请把这个事件落库，并把故事时间推进到第二天清晨。",
	"主角穿过庭院，在枯井边停下，夜色更深了。请记录这个事件，并把时间推进到深夜。",
	"主角走进王座大厅，壁炉余火未熄，他决定在此安顿过夜。请记录这个事件，并把时间推进到第二天黎明。",
];

const FORK_TURN_INPUT =
	"分叉后的第一轮：主角在井边发现刻着陌生符文的井盖，夜色正浓。请记录这个事件，并把时间推进到第二天早晨。";

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
	console.log(`===== M1 验收: ${failed === 0 ? "PASS" : "FAIL"}（${passCount}/${checks.length} 通过） =====`);
	if (failed > 0) process.exitCode = 1;
}

function hasTool(report: TurnReport, name: string): boolean {
	return report.toolCalls.some((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "tavernpi-m1-accept-"));
	const sessionDir = join(root, "sessions");
	const cwd = root;

	try {
		const sessionManager = SessionManager.create(cwd, sessionDir);
		const sessionId = sessionManager.getSessionId();
		const dbPath = coreStoryDbPath(root, sessionId);
		const storyState: M1StoryState = {
			storyDir: join(root, sessionId),
			storyDb: openStoryDb(dbPath),
			snapshotsDb: openSnapshotsDb(snapshotsDbPath(dbPath)),
		};
		const runtime = await buildM1Runtime({
			cwd,
			sessionManager,
			storyState,
			onWarning: (m) => console.log(`[warn] ${m}`),
		});
		console.log(`> session: ${sessionId}（文件 ${sessionManager.getSessionFile()}）`);
		console.log(`> storyDir: ${storyState.storyDir}`);
		console.log(`> 工具白名单: [${runtime.session.getActiveToolNames().join(", ")}]`);

		// ---- 三轮主线叙事 ----
		const reports: TurnReport[] = [];
		for (const [i, input] of ACCEPTANCE_TURNS.entries()) {
			console.log(`\n--- 第 ${i + 1} 轮: ${input} ---`);
			const report = await runM1Turn(runtime, input);
			reports.push(report);
			console.log(`  工具: ${report.toolCalls.length === 0 ? "(无)" : report.toolCalls.map((c) => c.name).join(", ")}`);
			console.log(`  clock=${report.clockAfter?.current_time ?? "?"} events=${report.eventsAfter.length} snapshots=${report.snapshotRowCount}`);
		}

		const checks: Check[] = [];
		for (const [i, r] of reports.entries()) {
			checks.push(check(`[工具] 第 ${i + 1} 轮调用 write_event`, hasTool(r, "write_event")));
			checks.push(check(`[工具] 第 ${i + 1} 轮调用 advance_clock`, hasTool(r, "advance_clock")));
		}

		// ---- 场景 1：回溯一致 ----
		// 1a：导航到第 2 轮 user entry（u2）→ 落点 = u2.parentId（a1，第 1 轮末），DB = 第 1 轮末参考态。
		console.log("\n--- 场景 1：回溯一致 ---");
		const s1a = await navigateToEntry(runtime, reports[1]!.userEntryId);
		checks.push(check("场景1a: 恢复结果 ok（restoredTurnSeq=1）", s1a?.ok === true && s1a?.restoredTurnSeq === 1));
		const s1aClock = runtime.storyState.storyDb.reader.getClock();
		const s1aEvents = runtime.storyState.storyDb.reader.listEvents();
		checks.push(
			check(
				`场景1a: clock == 第 1 轮后（${reports[0]!.clockAfter?.current_time}）`,
				s1aClock?.current_time === reports[0]!.clockAfter?.current_time,
			),
		);
		checks.push(
			check(
				`场景1a: events 行数 == 第 1 轮后（${reports[0]!.eventsAfter.length}）`,
				s1aEvents.length === reports[0]!.eventsAfter.length,
			),
		);
		checks.push(
			check(
				`场景1a: turn_log 同步（${reports[0]!.turnSeq} 行）`,
				runtime.storyState.storyDb.reader.getTurnLog().length === reports[0]!.turnSeq,
			),
		);

		// 1b：导航到第 1 轮 user entry（u1）→ 链上无快照 → 空库兜底 = 故事初始态（重做开头的一致状态）。
		const s1b = await navigateToEntry(runtime, reports[0]!.userEntryId);
		checks.push(check("场景1b: 恢复结果 ok（空库兜底，无 restoredTurnSeq）", s1b?.ok === true && s1b?.restoredTurnSeq === undefined));
		const s1bEvents = runtime.storyState.storyDb.reader.listEvents();
		const s1bClock = runtime.storyState.storyDb.reader.getClock();
		checks.push(check("场景1b: events == 0（故事初始态）", s1bEvents.length === 0));
		checks.push(
			check(
				`场景1b: clock == 初始值（${DEFAULT_STORY_CLOCK.current_time}）`,
				JSON.stringify(s1bClock) === JSON.stringify(DEFAULT_STORY_CLOCK),
			),
		);

		// ---- 场景 2：回溯后再前进（navigate 到第 3 轮 assistant leaf a3）----
		console.log("\n--- 场景 2：回溯后再前进 ---");
		const s2 = await navigateToEntry(runtime, reports[2]!.leafId);
		checks.push(check("场景2: 恢复结果 ok（restoredTurnSeq=3）", s2?.ok === true && s2?.restoredTurnSeq === 3));
		const s2Clock = runtime.storyState.storyDb.reader.getClock();
		checks.push(
			check(
				`场景2: clock == 第 3 轮后（${reports[2]!.clockAfter?.current_time}）`,
				s2Clock?.current_time === reports[2]!.clockAfter?.current_time,
			),
		);
		checks.push(check("场景2: events 行数 == 3", runtime.storyState.storyDb.reader.listEvents().length === 3));
		const snapCountS2 = runtime.storyState.snapshotsDb.listSnapshots().length;
		checks.push(
			check(`场景2: snapshots.db 行数不变（${snapCountS2} 份）`, snapCountS2 === reports[2]!.snapshotRowCount),
		);

		// ---- 场景 3：fork 独立（从第 2 轮末 assistant leaf a2 fork，clone/at 语义）----
		console.log("\n--- 场景 3：fork 独立 ---");
		const oldStoryState = runtime.storyState;
		const oldSessionId = runtime.sessionManager.getSessionId();
		const oldStoryDbPath = oldStoryState.storyDb.path;
		const oldEventsBefore = oldStoryState.storyDb.reader.listEvents();
		const oldClockBefore = oldStoryState.storyDb.reader.getClock();
		const oldSnapBefore = oldStoryState.snapshotsDb.listSnapshots();
		const oldTurnLogBefore = oldStoryState.storyDb.reader.getTurnLog();
		const forkTarget = reports[1]!.leafId; // a2：第 2 轮末 assistant leaf（快照绑定键）

		const chain = buildAncestorChain(runtime.sessionManager.getEntries(), forkTarget);
		const truncateId = forkTarget; // clone/at 语义：分支内容含到 a2 为止

		runtime.sessionManager.createBranchedSession(truncateId);
		const newSessionId = runtime.sessionManager.getSessionId();
		checks.push(check(`场景3: 新 sessionId ≠ 旧（${oldSessionId} → ${newSessionId}）`, newSessionId !== oldSessionId));

		const newStoryDir = join(root, newSessionId);
		const forkResult = forkStoryDb(oldStoryState.snapshotsDb, chain, newStoryDir);
		checks.push(check("场景3: 新故事 story.db == 第 2 轮后（events=2）", forkResult.storyDb.reader.listEvents().length === 2));
		checks.push(
			check(
				`场景3: 新故事 clock == 第 2 轮后（${reports[1]!.clockAfter?.current_time}）`,
				forkResult.storyDb.reader.getClock()?.current_time === reports[1]!.clockAfter?.current_time,
			),
		);
		checks.push(check("场景3: 新 snapshots.db 仅 1 份", forkResult.snapshotsDb.listSnapshots().length === 1));
		checks.push(
			check(
				`场景3: 新 snapshots.db 绑定 a2（${forkTarget}）`,
				forkResult.snapshotsDb.listSnapshots()[0]?.session_entry_id === forkTarget,
			),
		);

		// 换到新故事再跑 1 轮（回溯后再前进的写路径验证）
		runtime.session.dispose();
		oldStoryState.storyDb.close();
		oldStoryState.snapshotsDb.close();
		const forkStoryState: M1StoryState = {
			storyDir: newStoryDir,
			storyDb: forkResult.storyDb,
			snapshotsDb: forkResult.snapshotsDb,
		};
		const forkRuntime = await buildM1Runtime({
			cwd,
			sessionManager: runtime.sessionManager,
			storyState: forkStoryState,
			onWarning: (m) => console.log(`[warn] ${m}`),
		});
		console.log(`> fork 后新故事首轮: ${FORK_TURN_INPUT}`);
		const forkTurn = await runM1Turn(forkRuntime, FORK_TURN_INPUT);
		checks.push(check("场景3: fork 后新轮调用 write_event", hasTool(forkTurn, "write_event")));
		checks.push(check("场景3: fork 后新轮调用 advance_clock", hasTool(forkTurn, "advance_clock")));
		checks.push(check(`场景3: 新故事含新事件（${forkTurn.eventsAfter.length} 条）`, forkTurn.eventsAfter.length === 3));
		checks.push(check("场景3: 新故事 snapshots 增至 2 份", forkTurn.snapshotRowCount === 2));

		// 旧故事两库不动（逐行不变）
		const oldReopened = openStoryDb(oldStoryDbPath);
		const oldEventsAfter = oldReopened.reader.listEvents();
		checks.push(
			check(
				`场景3: 旧故事 story.db events 逐行不变（${oldEventsAfter.length} 条）`,
				oldEventsAfter.length === oldEventsBefore.length &&
					oldEventsAfter.every((e, i) => e.summary === oldEventsBefore[i]?.summary),
			),
		);
		checks.push(
			check(
				`场景3: 旧故事 clock 不变（${oldClockBefore?.current_time}）`,
				oldReopened.reader.getClock()?.current_time === oldClockBefore?.current_time,
			),
		);
		checks.push(
			check(`场景3: 旧故事 turn_log 不变（${oldTurnLogBefore.length} 行）`, oldReopened.reader.getTurnLog().length === oldTurnLogBefore.length),
		);
		const oldSnapReopened = openSnapshotsDb(snapshotsDbPath(oldStoryDbPath));
		checks.push(
			check(
				`场景3: 旧故事 snapshots.db 行数不变（${oldSnapBefore.length} 份）`,
				oldSnapReopened.listSnapshots().length === oldSnapBefore.length,
			),
		);

		oldReopened.close();
		oldSnapReopened.close();
		forkRuntime.dispose();
		forkRuntime.storyState.storyDb.close();
		forkRuntime.storyState.snapshotsDb.close();

		console.log("\n===== M1 验收检查表 =====");
		printChecks(checks);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
