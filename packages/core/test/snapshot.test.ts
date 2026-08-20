// 快照管理器单测：祖先链、快照往返（含合法 stale WAL）、空库兜底与外部损伤判失败、fork、
// hooks 挂载、真实路径失败回退、双故障窗口、临时文件清理。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionContext, SessionBeforeTreeEvent, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { openStoryDb, StoryDb, type StoryDb as StoryDbHandle } from "../src/db/story-db.ts";
import { DEFAULT_STORY_CLOCK } from "../src/db/types.ts";
import { openSnapshotsDb, snapshotsDbPath, takeSnapshot } from "../src/snapshot/snapshots-db.ts";
import { cleanupTempFiles, removeWalFiles, resetToEmptyStoryDb, restoreSnapshot } from "../src/snapshot/restore.ts";
import { buildAncestorChain } from "../src/snapshot/ancestors.ts";
import { createSnapshotHooks } from "../src/snapshot/hooks.ts";
import { forkStoryDb } from "../src/snapshot/fork.ts";
import { cleanupTempDir, makeTempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// 祖先链
// ---------------------------------------------------------------------------

test("buildAncestorChain：沿 parentId 回溯（含自身，近→远）；目标不存在 → 空链；乱序输入不影响", () => {
	const entries = [
		{ id: "root", parentId: null },
		{ id: "b", parentId: "root" },
		{ id: "c", parentId: "b" },
		{ id: "d", parentId: "c" },
	];
	assert.deepEqual(buildAncestorChain(entries, "d"), ["d", "c", "b", "root"]);
	assert.deepEqual(buildAncestorChain(entries, "root"), ["root"]);
	assert.deepEqual(buildAncestorChain(entries, "ghost"), []);
	// 输入乱序不影响结果（按链序）
	assert.deepEqual(buildAncestorChain([...entries].reverse(), "d"), ["d", "c", "b", "root"]);
});

test("findNearestSnapshot：链上多快照取最近（按链序，不按 id 序）；无快照/空链 → undefined", () => {
	const dir = makeTempDir();
	try {
		const snap = openSnapshotsDb(join(dir, "snapshots.db"));
		snap.insertSnapshot({ turnSeq: 1, sessionEntryId: "a1", dump: new Uint8Array([1]) });
		snap.insertSnapshot({ turnSeq: 3, sessionEntryId: "c3", dump: new Uint8Array([3]) });
		snap.insertSnapshot({ turnSeq: 5, sessionEntryId: "e5", dump: new Uint8Array([5]) });
		// 链近→远 e5 → c3 → a1：取最近 e5
		const near = snap.findNearestSnapshot(["e5", "c3", "a1"]);
		assert.equal(near?.session_entry_id, "e5");
		assert.deepEqual(near?.dump, new Uint8Array([5]));
		// 链从中间开始：取 c3（链序优先，id 序无关）
		const mid = snap.findNearestSnapshot(["c3", "a1"]);
		assert.equal(mid?.session_entry_id, "c3");
		// 链上无快照
		assert.equal(snap.findNearestSnapshot(["x", "y", "z"]), undefined);
		assert.equal(snap.findNearestSnapshot([]), undefined);
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 快照往返与合法 stale WAL
// ---------------------------------------------------------------------------

test("快照往返 + 合法 stale WAL：恢复清除残留（读不到 stale 数据），round-trip 回到快照时刻", async () => {
	const dir = makeTempDir();
	const storyPath = join(dir, "story.db");
	try {
		// 快照前状态：1 事件 s1
		const story = openStoryDb(storyPath);
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		await takeSnapshot(story, { turnSeq: 1, sessionEntryId: "entry-1" });
		// 快照后继续写 s2（未检查点，帧在 WAL 里）
		story.writer.insertEvent({ turnSeq: 2, summary: "s2" });
		const staleWal = readFileSync(storyPath + "-wal");
		assert.ok(staleWal.length > 0, "快照后的写入应留在 WAL 帧中（未检查点）");
		const staleShm = existsSync(storyPath + "-shm") ? readFileSync(storyPath + "-shm") : null;
		story.close();

		// 放回合法 stale WAL（模拟崩溃/异常关闭后残留的未检查点写入）。
		writeFileSync(storyPath + "-wal", staleWal);
		if (staleShm) {
			writeFileSync(storyPath + "-shm", staleShm);
		}

		// 以只读句柄走 restoreSnapshot：只读连接 close 不触发 checkpoint，stale WAL 原样存活，
		// 恰好落在 close→rename→reopen 窗口 —— 若 removeWalFiles 未生效，reopen 会把 stale
		// WAL 的 s2 重放到快照 dump 上（污染）。
		const roHandle = new StoryDb(storyPath, new DatabaseSync(storyPath, { readOnly: true }));
		const snap = openSnapshotsDb(snapshotsDbPath(storyPath));
		const record = snap.findNearestSnapshot(["entry-1"]);
		assert.ok(record, "应找到 entry-1 的快照");
		const restored = restoreSnapshot(roHandle, record.dump);
		snap.close();

		// 恢复后读不到 stale WAL 的数据（只有快照时刻的 s1）
		const summaries = restored.reader.listEvents().map((e) => e.summary);
		assert.deepEqual(summaries, ["s1"]);
		assert.ok(!summaries.includes("s2"), "stale WAL 数据不得污染恢复结果");
		assert.deepEqual(restored.reader.listWorldState(), []);
		restored.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("removeWalFiles：删除残留 -wal/-shm（防崩溃残留重放污染）", () => {
	const dir = makeTempDir();
	const p = join(dir, "story.db");
	writeFileSync(p + "-wal", Buffer.from("stale"));
	writeFileSync(p + "-shm", Buffer.from("stale"));
	removeWalFiles(p);
	assert.ok(!existsSync(p + "-wal"));
	assert.ok(!existsSync(p + "-shm"));
	cleanupTempDir(dir);
});

test("cleanupTempFiles：清理 .restore-*/.snapshot-* 崩溃残留文件，跳过目录与非残留", () => {
	const dir = makeTempDir();
	try {
		writeFileSync(join(dir, ".restore-1.tmp"), "a");
		writeFileSync(join(dir, ".snapshot-2.tmp"), "b");
		writeFileSync(join(dir, "keep.txt"), "c");
		mkdirSync(join(dir, ".restore-dir"));
		writeFileSync(join(dir, ".restore-dir", "inner"), "d");
		cleanupTempFiles(dir);
		assert.ok(!existsSync(join(dir, ".restore-1.tmp")));
		assert.ok(!existsSync(join(dir, ".snapshot-2.tmp")));
		assert.ok(existsSync(join(dir, "keep.txt")));
		assert.ok(existsSync(join(dir, ".restore-dir")), "目录应被跳过（只清理文件）");
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// 空库兜底 & 外部损伤判失败
// ---------------------------------------------------------------------------

test("resetToEmptyStoryDb：恢复到干净初始库（migrate 后 + 默认 clock，无数据）", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		story.writer.advanceClock({ turnSeq: 1, toTime: "0000-02-02" });
		const reset = resetToEmptyStoryDb(story);
		assert.equal(reset.reader.listEvents().length, 0);
		assert.equal(reset.reader.listWorldState().length, 0);
		assert.equal(reset.reader.getTurnLog().length, 0);
		assert.equal(reset.reader.listNpcs().length, 0);
		// 默认 clock（DEFAULT_STORY_CLOCK 初值）
		assert.deepEqual({ ...reset.reader.getClock() }, DEFAULT_STORY_CLOCK);
		reset.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// fork/clone 初始 DB
// ---------------------------------------------------------------------------

test("forkStoryDb：新库 = 目标祖先链最近快照时刻；新 snapshots.db 仅该一份快照；fork 后互相独立；空链 → 空库", async () => {
	const dir = makeTempDir();
	try {
		const srcStory = openStoryDb(join(dir, "src", "story.db"));
		srcStory.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		await takeSnapshot(srcStory, { turnSeq: 1, sessionEntryId: "entry-1" });
		srcStory.writer.insertEvent({ turnSeq: 2, summary: "s2" });
		await takeSnapshot(srcStory, { turnSeq: 2, sessionEntryId: "entry-2" });
		srcStory.writer.insertEvent({ turnSeq: 3, summary: "s3" });
		assert.equal(srcStory.reader.listEvents().length, 3);

		const srcSnap = openSnapshotsDb(snapshotsDbPath(srcStory.path));
		// 从 entry-2 分叉：取 entry-2 快照（此时 2 事件）
		const fork = forkStoryDb(srcSnap, ["entry-2", "entry-1"], join(dir, "fork"));
		assert.equal(fork.storyDb.reader.listEvents().length, 2);
		assert.equal(fork.storyDb.reader.listEvents()[1]?.summary, "s2");
		// 新 snapshots.db 仅一份快照（entry-2）
		const forkSnaps = fork.snapshotsDb.listSnapshots();
		assert.equal(forkSnaps.length, 1);
		assert.equal(forkSnaps[0]?.session_entry_id, "entry-2");

		// fork 后独立：写 fork 不影响 src
		fork.storyDb.writer.insertEvent({ turnSeq: 3, summary: "fork-only" });
		assert.equal(srcStory.reader.listEvents().length, 3);

		// 空链 fork：空库初始状态 + 空 snapshots.db
		const emptyFork = forkStoryDb(srcSnap, [], join(dir, "empty-fork"));
		assert.equal(emptyFork.storyDb.reader.listEvents().length, 0);
		assert.equal(emptyFork.snapshotsDb.listSnapshots().length, 0);

		srcSnap.close();
		srcStory.close();
		fork.storyDb.close();
		fork.snapshotsDb.close();
		emptyFork.storyDb.close();
		emptyFork.snapshotsDb.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("forkStoryDb：目标目录复用安全（残留 WAL 被清、崩溃临时文件被清）", async () => {
	const dir = makeTempDir();
	try {
		const srcStory = openStoryDb(join(dir, "src", "story.db"));
		srcStory.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		await takeSnapshot(srcStory, { turnSeq: 1, sessionEntryId: "entry-1" });
		const srcSnap = openSnapshotsDb(snapshotsDbPath(srcStory.path));

		// 目标目录已存在且带残留
		const targetDir = join(dir, "reused");
		mkdirSync(targetDir, { recursive: true });
		writeFileSync(join(targetDir, "story.db-wal"), Buffer.from("STALE-WAL"));
		writeFileSync(join(targetDir, ".restore-crash.tmp"), Buffer.from("old-tmp"));

		const fork = forkStoryDb(srcSnap, ["entry-1"], targetDir);
		assert.deepEqual(fork.storyDb.reader.listEvents().map((e) => e.summary), ["s1"]);
		assert.ok(!existsSync(join(targetDir, ".restore-crash.tmp")), "崩溃临时文件应被清理");
		// 残留 wal 不得留下：若新库有 wal 则是新建（WAL 模式），非残留字节
		if (existsSync(join(targetDir, "story.db-wal"))) {
			assert.notEqual(readFileSync(join(targetDir, "story.db-wal")).toString(), "STALE-WAL");
		}

		srcSnap.close();
		srcStory.close();
		fork.storyDb.close();
		fork.snapshotsDb.close();
	} finally {
		cleanupTempDir(dir);
	}
});

// ---------------------------------------------------------------------------
// hooks 挂载
// ---------------------------------------------------------------------------

const bt = (targetId: string): SessionBeforeTreeEvent =>
	({
		type: "session_before_tree",
		preparation: {
			targetId,
			oldLeafId: "old-leaf",
			commonAncestorId: null,
			entriesToSummarize: [],
			userWantsSummary: false,
		},
		signal: undefined,
	}) as unknown as SessionBeforeTreeEvent;

const tt = (newLeafId: string | null): SessionTreeEvent =>
	({ type: "session_tree", newLeafId, oldLeafId: "old-leaf" }) as unknown as SessionTreeEvent;

const fakeCtx = {} as unknown as ExtensionContext;

test("hooks：before_tree 定位快照 → tree 执行恢复；lastRestoreResult 正确且 storyDb 被替换", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		await takeSnapshot(story, { turnSeq: 1, sessionEntryId: "entry-1" });
		story.writer.insertEvent({ turnSeq: 2, summary: "s2" }); // 快照后继续写

		const snap = openSnapshotsDb(snapshotsDbPath(story.path));
		let current: StoryDbHandle = story;
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => current,
			setStoryDb: (db) => {
				current = db;
			},
			getEntryAncestors: (id) => (id === "entry-1" ? ["entry-1"] : []),
		});

		hooks.sessionBeforeTree(bt("entry-1"), fakeCtx);
		assert.equal(hooks.state.warnings.length, 0);
		hooks.sessionTree(tt("entry-1"), fakeCtx);

		assert.equal(hooks.state.lastRestoreResult?.ok, true);
		assert.equal(hooks.state.lastRestoreResult?.restoredTurnSeq, 1);
		assert.equal(hooks.state.lastRestoreResult?.restoredEntryId, "entry-1");
		// storyDb 已被替换为新实例且内容 = 快照时刻（1 事件 s1）
		assert.equal(current.reader.listEvents().length, 1);
		assert.equal(current.reader.listEvents()[0]?.summary, "s1");
		assert.notEqual(current, story);

		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：祖先链无快照且无历史 → 空库兜底（warning 记录），tree 恢复到干净库", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" }); // 有事件但无 turn_log（无历史）
		const snap = openSnapshotsDb(snapshotsDbPath(story.path)); // 空 snapshots.db

		let current: StoryDbHandle = story;
		const warnings: string[] = [];
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => current,
			setStoryDb: (db) => {
				current = db;
			},
			getEntryAncestors: () => [],
			onWarning: (m) => warnings.push(m),
		});

		hooks.sessionBeforeTree(bt("root-msg"), fakeCtx);
		assert.equal(hooks.state.warnings.length, 1);
		assert.ok(warnings.length === 1);
		hooks.sessionTree(tt(null), fakeCtx); // newLeafId=null（resetLeaf 场景）

		assert.equal(hooks.state.lastRestoreResult?.ok, true);
		assert.equal(current.reader.listEvents().length, 0);
		assert.deepEqual({ ...current.reader.getClock() }, DEFAULT_STORY_CLOCK);
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：祖先链无快照但 turn_log 非空且存在 data ok 轮（外部损伤）→ 判恢复失败，不静默擦空库", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		story.writer.recordTurnLog({ turnSeq: 1, sessionEntryId: "e1", userInput: "u", narrativeText: "n" });
		// 有成功落库轮（status=ok）却无任何快照 = 外部损伤（M2 修订后的判据）
		story.writer.recordDataStatus({ turnSeq: 1, status: "ok", attempts: 1 });
		const snap = openSnapshotsDb(snapshotsDbPath(story.path)); // 空 snapshots.db

		let current: StoryDbHandle = story;
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => current,
			setStoryDb: (db) => {
				current = db;
			},
			getEntryAncestors: () => [],
		});

		hooks.sessionBeforeTree(bt("e1"), fakeCtx);
		hooks.sessionTree(tt("e1"), fakeCtx);

		assert.equal(hooks.state.lastRestoreResult?.ok, false);
		assert.ok(hooks.state.lastRestoreResult?.error?.includes("turn_log 非空"));
		// 库未被替换、未被擦除
		assert.equal(current, story);
		assert.equal(current.reader.getTurnLog().length, 1);
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：data 全 failed（M2 合法态，失败轮无快照）→ 空库兜底放行，不判损伤", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		story.writer.recordTurnLog({ turnSeq: 1, sessionEntryId: "e1", userInput: "u", narrativeText: "n" });
		// 只有 failed 轮（§6.1：失败轮不拍快照 → snapshots.db 为空属合法），无 ok 轮
		story.writer.recordDataStatus({ turnSeq: 1, status: "failed", attempts: 3, error: "校验失败" });
		const snap = openSnapshotsDb(snapshotsDbPath(story.path)); // 空 snapshots.db

		let current: StoryDbHandle = story;
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => current,
			setStoryDb: (db) => {
				current = db;
			},
			getEntryAncestors: () => [],
		});

		hooks.sessionBeforeTree(bt("e1"), fakeCtx);
		hooks.sessionTree(tt("e1"), fakeCtx);

		assert.equal(hooks.state.lastRestoreResult?.ok, true, "全 failed → 空库兜底放行（§3.1）");
		assert.equal(current.reader.listEvents().length, 0, "空库兜底 = 故事初始态");
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：恢复失败（writeFileSync 真实路径 EISDIR）→ lastRestoreResult.ok=false，句柄被重开回退（不楔死）", async () => {
	const dir = makeTempDir();
	const storyPath = join(dir, "story.db");
	try {
		const story = openStoryDb(storyPath);
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		await takeSnapshot(story, { turnSeq: 1, sessionEntryId: "entry-1" });
		story.writer.insertEvent({ turnSeq: 2, summary: "s2" });

		const snap = openSnapshotsDb(snapshotsDbPath(storyPath));
		let current: StoryDbHandle = story;
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => current,
			setStoryDb: (db) => {
				current = db;
			},
			getEntryAncestors: () => ["entry-1"],
		});
		hooks.sessionBeforeTree(bt("entry-1"), fakeCtx);

		// 真实路径失败注入：把 restoreSnapshot 的临时文件路径（.restore-<pid>-<Date.now()>.tmp）
		// 预先变成一个目录，使 writeFileSync 抛 EISDIR —— 落在 close 之后、rename 之前窗口。
		// Date.now 只用于钉住文件名，失败本身是真实文件系统错误。
		const realNow = Date.now;
		const pinned = 1234567890123;
		Date.now = () => pinned;
		const tmpDir = join(dir, `.restore-${process.pid}-${pinned}.tmp`);
		mkdirSync(tmpDir);
		writeFileSync(join(tmpDir, "blocker"), "x");
		try {
			// 不向上抛（pi 会吞 handler 异常；我们自吞并落状态 + 重开回退）
			assert.doesNotThrow(() => hooks.sessionTree(tt("entry-1"), fakeCtx));
		} finally {
			Date.now = realNow;
		}

		assert.equal(hooks.state.lastRestoreResult?.ok, false);
		assert.ok(hooks.state.lastRestoreResult?.error && hooks.state.lastRestoreResult.error.length > 0);
		// 死句柄回退：current 是重开的新实例（非原对象），旧库数据完好（s1+s2）且可继续读写
		assert.notEqual(current, story);
		assert.deepEqual(
			current.reader.listEvents().map((e) => e.summary),
			["s1", "s2"],
		);
		current.close();
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：before_tree 抛错 → 不消费上次遗留 pending（防双故障窗口）", async () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		story.writer.insertEvent({ turnSeq: 1, summary: "s1" });
		await takeSnapshot(story, { turnSeq: 1, sessionEntryId: "entry-1" });
		story.writer.insertEvent({ turnSeq: 2, summary: "s2" });
		const snap = openSnapshotsDb(snapshotsDbPath(story.path));

		let current: StoryDbHandle = story;
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => current,
			setStoryDb: (db) => {
				current = db;
			},
			getEntryAncestors: (id) => {
				if (id === "boom") {
					throw new Error("祖先链构建失败");
				}
				return ["entry-1"];
			},
		});

		// 第一次导航正常准备（pending = snapshot）
		hooks.sessionBeforeTree(bt("entry-1"), fakeCtx);
		// 第二次 before_tree 抛错（pi 会吞掉）→ 入口清 pending
		assert.throws(() => hooks.sessionBeforeTree(bt("boom"), fakeCtx));
		// tree 不得消费第一次遗留的 pending
		hooks.sessionTree(tt("entry-1"), fakeCtx);

		assert.equal(hooks.state.lastRestoreResult?.ok, false);
		assert.ok(hooks.state.lastRestoreResult?.error?.includes("无待恢复快照"));
		// 库未被替换、未被恢复
		assert.equal(current, story);
		assert.deepEqual(
			current.reader.listEvents().map((e) => e.summary),
			["s1", "s2"],
		);
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：tree 无待恢复快照（before_tree 未先执行）→ 失败标志置位", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db"));
		const snap = openSnapshotsDb(snapshotsDbPath(story.path));
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => story,
			setStoryDb: () => {},
			getEntryAncestors: () => [],
		});
		hooks.sessionTree(tt("entry-1"), fakeCtx);
		assert.equal(hooks.state.lastRestoreResult?.ok, false);
		assert.ok(hooks.state.lastRestoreResult?.error?.includes("无待恢复快照"));
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});

test("hooks：state.warnings 保留最近 50 条（上界）", () => {
	const dir = makeTempDir();
	try {
		const story = openStoryDb(join(dir, "story.db")); // 无 turn_log → 空库兜底 warning
		const snap = openSnapshotsDb(snapshotsDbPath(story.path));
		const hooks = createSnapshotHooks({
			snapshotsDb: snap,
			getStoryDb: () => story,
			setStoryDb: () => {},
			getEntryAncestors: () => [],
		});
		for (let i = 0; i < 55; i++) {
			hooks.sessionBeforeTree(bt(`e${i}`), fakeCtx);
		}
		assert.equal(hooks.state.warnings.length, 50);
		snap.close();
	} finally {
		cleanupTempDir(dir);
	}
});
