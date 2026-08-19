// 故事目录与打开（§5.1 布局：<storiesRoot>/<session-id>/story.db + snapshots.db）。
// 本阶段只建 story.db；snapshots.db 是 M1-P2（快照管理器）。

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.ts";
import { DbReader } from "./reader.ts";
import { DbWriter } from "./writer.ts";
import { DEFAULT_STORY_CLOCK } from "./types.ts";

/** 默认故事根目录 ~/.tavernpi/stories。可注入替换（测试用临时目录）。 */
export function defaultStoriesRoot(): string {
	return join(homedir(), ".tavernpi", "stories");
}

/** 故事 DB 路径：<storiesRoot>/<session-id>/story.db。sessionId 限安全字符集（防路径穿越）。 */
export function storyDbPath(storiesRoot: string, sessionId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
		throw new Error(`非法 sessionId: ${JSON.stringify(sessionId)}（仅允许 [A-Za-z0-9_-]）`);
	}
	return join(storiesRoot, sessionId, "story.db");
}

/** 打开后的故事 DB 封装。业务写入一律经 writer（turn_seq 纪律），读取经 reader。 */
export class StoryDb {
	readonly path: string;
	readonly reader: DbReader;
	readonly writer: DbWriter;
	private readonly raw: DatabaseSync;

	constructor(dbPath: string, db: DatabaseSync) {
		this.path = dbPath;
		this.raw = db;
		this.reader = new DbReader(db);
		this.writer = new DbWriter(db);
	}

	/**
	 * 原始 DatabaseSync。仅供快照备份（M1-P2）、migration 等基础设施使用；
	 * 业务写入必须走 writer —— 绕过 writer 即绕过 turn_seq 纪律。
	 */
	get rawDb(): DatabaseSync {
		return this.raw;
	}

	close(): void {
		this.raw.close();
	}
}

/**
 * 打开（或创建）故事 DB：WAL 模式、外键开启、执行 core migration、种入默认 clock。
 */
export function openStoryDb(dbPath: string): StoryDb {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	ensureDefaultClock(db);
	return new StoryDb(dbPath, db);
}

/** 种入默认 clock 单例（幂等：仅当 clock 为空）。初值见 DEFAULT_STORY_CLOCK，待 M2 校准。
 *  current_time 是 SQLite 关键字（CURRENT_TIME），列名加引号限定。 */
function ensureDefaultClock(db: DatabaseSync): void {
	const row = db.prepare("SELECT COUNT(*) AS c FROM clock").get() as { c: number };
	if (row.c === 0) {
		db.prepare('INSERT INTO clock (id, "current_time", calendar, granularity) VALUES (1, ?, ?, ?)').run(
			DEFAULT_STORY_CLOCK.current_time,
			DEFAULT_STORY_CLOCK.calendar,
			DEFAULT_STORY_CLOCK.granularity,
		);
	}
}
