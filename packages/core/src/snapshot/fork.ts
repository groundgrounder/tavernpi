// fork/clone 初始 DB（§3.1）：目标 entry 祖先链最近快照的 dump → 新故事 story.db；
// 新故事 snapshots.db 初始化为仅含该一份快照。空链 / 无快照 → 空库初始状态。
// 目标目录复用安全：写 story.db 前先清除残留 WAL/SHM 与崩溃残留临时文件。

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStoryDb, type StoryDb } from "../db/story-db.ts";
import { cleanupTempFiles, removeWalFiles } from "./restore.ts";
import { openSnapshotsDb, type SnapshotsDb } from "./snapshots-db.ts";

export interface ForkResult {
	storyDb: StoryDb;
	snapshotsDb: SnapshotsDb;
}

export function forkStoryDb(
	sourceSnapshotsDb: SnapshotsDb,
	entryAncestors: ReadonlyArray<string>,
	targetDir: string,
): ForkResult {
	mkdirSync(targetDir, { recursive: true });
	// 目录复用安全：清残留临时文件 + 目标 story.db 的 WAL/SHM（防旧残留污染新库）
	cleanupTempFiles(targetDir);
	const storyPath = join(targetDir, "story.db");
	removeWalFiles(storyPath);

	const nearest = sourceSnapshotsDb.findNearestSnapshot(entryAncestors);
	const storyDb = nearest ? storyDbFromDump(storyPath, nearest.dump) : openStoryDb(storyPath);

	const snapDb = openSnapshotsDb(join(targetDir, "snapshots.db"));
	if (nearest) {
		snapDb.insertSnapshot({
			turnSeq: nearest.turn_seq,
			sessionEntryId: nearest.session_entry_id,
			dump: nearest.dump,
		});
	}
	return { storyDb, snapshotsDb: snapDb };
}

/** 以 dump 原子写入新 story.db（临时文件 + rename），再打开。 */
function storyDbFromDump(dbPath: string, dump: Uint8Array): StoryDb {
	const tmpPath = `${dbPath}.fork-tmp`;
	writeFileSync(tmpPath, dump);
	renameSync(tmpPath, dbPath);
	return openStoryDb(dbPath);
}
