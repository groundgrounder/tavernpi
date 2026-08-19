// 原子恢复（§3.1 / 技术路线 §6 快照原子性）。
// 恢复语义：清理崩溃残留 tmp → 关闭连接 → 显式清除 WAL/SHM 残留 → dump 先写临时文件再
// rename 原子替换 story.db → 重连。
// 「重开并返回新 StoryDb」vs「同对象重绑」取舍：
//   选**重开（返回新实例）**——StoryDb 的 reader/writer 是构造时 readonly 绑定，同对象重绑需改写
//   其内部私有状态且旧引用易失效；重开语义与「关闭→替换→重连」一一对应，调用方替换引用即可
//   （hooks 层以 get/set 容器持有 StoryDb，天然支持替换）。
//
// 消费契约：本函数会**关闭（消费）传入的 StoryDb 句柄**。成功时返回新实例；失败时旧库文件
// 未触碰（rename 前崩溃任一点可恢复），但传入句柄已失效——调用方必须用 openStoryDb(path)
// 重开（hooks 层的 catch 已做重开回退，见 hooks.ts）。

import { existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openStoryDb, type StoryDb } from "../db/story-db.ts";

/**
 * best-effort 清理崩溃残留的临时文件（`.restore-*` / `.snapshot-*`）。
 * 只删普通文件，跳过目录与不可读项；任何失败吞掉（best-effort）。
 */
export function cleanupTempFiles(dir: string): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(".restore-") && !name.startsWith(".snapshot-")) {
			continue;
		}
		const p = join(dir, name);
		try {
			if (statSync(p).isFile()) {
				rmSync(p, { force: true });
			}
		} catch {
			// best-effort：跳过
		}
	}
}

/** 显式删除 story.db 的 WAL/SHM 残留文件（防崩溃残留重放污染，gate M1-WAL 实证危害）。 */
export function removeWalFiles(dbPath: string): void {
	for (const suffix of ["-wal", "-shm"] as const) {
		const p = dbPath + suffix;
		if (existsSync(p)) {
			rmSync(p, { force: true });
		}
	}
}

/**
 * 原子恢复：把 dump（backup 字节）恢复到 story.db。
 * 失败语义：rename 之前任何一步抛错，旧 story.db 文件均未被触碰（崩溃任一点可恢复）；
 * 传入句柄会被消费（关闭），失败时调用方需重开（hooks 已处理）。rename 之后（重连）失败
 * 属于 dump 本身损坏的病理情形，由调用方（hooks）显式降级。
 */
export function restoreSnapshot(storyDb: StoryDb, dump: Uint8Array): StoryDb {
	const dbPath = storyDb.path;
	// 0. 清理此前崩溃留下的临时文件（best-effort）
	cleanupTempFiles(dirname(dbPath));
	// 1. 关闭连接（恢复期间不能有活跃读写；干净关闭会触发 SQLite 自动 checkpoint）
	storyDb.close();
	// 2. 显式清除 WAL/SHM 残留，防止陈旧 WAL 在新 story.db 上重放污染
	removeWalFiles(dbPath);
	// 3. dump 先写临时文件，再原子 rename 替换 story.db
	const tmpPath = join(dirname(dbPath), `.restore-${process.pid}-${Date.now()}.tmp`);
	writeFileSync(tmpPath, dump);
	renameSync(tmpPath, dbPath);
	// 4. 重连（新实例）
	return openStoryDb(dbPath);
}

/**
 * 空库初始状态兜底（§3.1：祖先链无快照 / 导航到根级 user 消息 newLeafId=null 时，
 * 且故事尚无历史——turn_log 为空。有历史的无快照属外部损伤，见 hooks.ts 的拒绝逻辑）。
 * 语义 = 新迁移的干净库 + 默认 clock（与 fork 空链初始状态一致）。
 */
export function resetToEmptyStoryDb(storyDb: StoryDb): StoryDb {
	const dbPath = storyDb.path;
	storyDb.close();
	removeWalFiles(dbPath);
	if (existsSync(dbPath)) {
		rmSync(dbPath, { force: true });
	}
	return openStoryDb(dbPath);
}
