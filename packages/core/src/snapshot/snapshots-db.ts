// 快照存储（独立 snapshots.db，§3.1）。
// dump 格式决策：直接存 node:sqlite backup() 生成的完整数据库文件字节。
//   backup 是 SQLite 官方一致的物理快照，包含 WAL 中已提交内容，且天然包含
//   turn_log/time_log/directives 等全部表 —— 满足 §3.1「dump = 当时 story.db 的全量导出」意图，
//   实现最简且已实证（spike/06）。逻辑导出（SQL 序列化）在数据量增长后如需可换，不影响表结构。

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { StoryDb } from "../db/story-db.ts";

export interface SnapshotRecord {
	turn_seq: number;
	session_entry_id: string;
	dump: Uint8Array;
}

const SNAPSHOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS snapshots (
  turn_seq INTEGER NOT NULL,
  session_entry_id TEXT NOT NULL,
  dump BLOB NOT NULL,
  PRIMARY KEY (turn_seq, session_entry_id)
);
`;

/** snapshots.db 路径：与 story.db 同目录（§5.1）。 */
export function snapshotsDbPath(storyDbPath: string): string {
	return join(dirname(storyDbPath), "snapshots.db");
}

/** snapshots.db 封装（独立 schema，不走 core migrate 框架）。 */
export class SnapshotsDb {
	readonly path: string;
	readonly db: DatabaseSync;

	constructor(dbPath: string) {
		this.path = dbPath;
		this.db = new DatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(SNAPSHOTS_SCHEMA_SQL);
	}

	/**
	 * 写入一份快照。同 (turn_seq, session_entry_id) 重复写入幂等覆盖
	 * （编排器重试/重复调用安全；data 失败轮不拍快照是编排器职责，本层不判断）。
	 */
	insertSnapshot(input: { turnSeq: number; sessionEntryId: string; dump: Uint8Array }): void {
		this.db
			.prepare(
				`INSERT INTO snapshots (turn_seq, session_entry_id, dump) VALUES (?, ?, ?)
				 ON CONFLICT(turn_seq, session_entry_id) DO UPDATE SET dump = excluded.dump`,
			)
			.run(input.turnSeq, input.sessionEntryId, input.dump);
	}

	/**
	 * 祖先链最近快照。entryAncestors = 目标 entry 的祖先链（含自身，从近到远）。
	 * entry id 无全局序，只按祖先关系：按链序找第一个有快照的 entry。
	 * 空链 / 链上无快照 → undefined（调用方据此走「空库初始状态」兜底，§3.1）。
	 */
	findNearestSnapshot(entryAncestors: ReadonlyArray<string>): SnapshotRecord | undefined {
		for (const id of entryAncestors) {
			const row = this.db
				.prepare("SELECT turn_seq, session_entry_id, dump FROM snapshots WHERE session_entry_id = ?")
				.get(id) as SnapshotRecord | undefined;
			if (row) {
				return row;
			}
		}
		return undefined;
	}

	/** 快照清单（含 dump 字节数；供测试与诊断）。 */
	listSnapshots(): Array<{ turn_seq: number; session_entry_id: string; dumpSize: number }> {
		return this.db
			.prepare(
				"SELECT turn_seq, session_entry_id, length(dump) AS dumpSize FROM snapshots ORDER BY turn_seq",
			)
			.all() as unknown as Array<{ turn_seq: number; session_entry_id: string; dumpSize: number }>;
	}

	close(): void {
		this.db.close();
	}
}

export function openSnapshotsDb(dbPath: string): SnapshotsDb {
	return new SnapshotsDb(dbPath);
}

/**
 * 拍快照：backup() 生成 story.db 的完整副本字节 → 存入 snapshots.db。
 * 源连接打开可用，且含 WAL 已提交内容（spike/06 实证）。
 */
export async function takeSnapshot(
	storyDb: StoryDb,
	input: { turnSeq: number; sessionEntryId: string },
): Promise<{ rowCount: number }> {
	const snap = openSnapshotsDb(snapshotsDbPath(storyDb.path));
	const tmpDumpPath = join(dirname(storyDb.path), `.snapshot-${Date.now()}-${input.sessionEntryId}.tmp`);
	try {
		await backup(storyDb.rawDb, tmpDumpPath);
		const dump = readFileSync(tmpDumpPath);
		snap.insertSnapshot({ turnSeq: input.turnSeq, sessionEntryId: input.sessionEntryId, dump });
		return { rowCount: snap.listSnapshots().length };
	} finally {
		if (existsSync(tmpDumpPath)) {
			rmSync(tmpDumpPath, { force: true });
		}
		snap.close();
	}
}
