// 设定集热更新（创作规划 §8 决策行「设定集热更新」：注入热、seed 冷，2026-08-22 定案）。
// PackCache：mtime 缓存 + 校验失败回退上次成功快照。
//   - 内部记录全部相关文件（yaml/yml/sql/md/json）的最新 mtime；
//   - getPacks() 每次扫描 mtime，有变化才 reload（注入热：作者改文本下一轮生效）；
//   - reload 校验失败 → 回退上次成功加载的 packs 快照 + warning（不阻塞游戏）；
//   - 首次加载失败直接抛 PackLoadError。
// 注：seed 不随卡包更新（seed 冷）——packMigrations 在故事创建时构建并落 schema_migrations。

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadPacks } from "./loader.ts";
import { PackLoadError, type WorldPack } from "./types.ts";

/** 参与 mtime 追踪的文件扩展名（yaml/yml/sql/md/json，§4.1 相关文件）。 */
const TRACKED_EXT = /\.(yaml|yml|sql|md|json)$/i;

export class PackCache {
	private readonly dirs: string[];
	/** 上次成功加载的快照（packs + 当时的 mtime 指纹）。 */
	private snapshot: { packs: WorldPack[]; mtimes: Map<string, number> } | null = null;
	private lastWarnings: string[] = [];

	constructor(dirs: string[]) {
		this.dirs = [...dirs];
	}

	/**
	 * 取当前生效的 packs。mtime 有变化才重载；重载失败回退上次成功快照 + warning；
	 * 首次加载失败直接抛 PackLoadError。
	 * 注意：回退时**不更新** mtime 指纹——每次调用都会重新尝试加载，作者修好后自动恢复。
	 */
	getPacks(): { packs: WorldPack[]; warnings: string[] } {
		const mtimes = collectMtimes(this.dirs);
		if (this.snapshot !== null && sameMtimes(mtimes, this.snapshot.mtimes)) {
			return { packs: this.snapshot.packs, warnings: this.lastWarnings };
		}
		try {
			const packs = loadPacks(this.dirs);
			this.snapshot = { packs, mtimes };
			this.lastWarnings = [];
			return { packs, warnings: [] };
		} catch (err) {
			if (this.snapshot !== null && err instanceof PackLoadError) {
				const warnings = [`卡包重载校验失败，回退上次成功加载的快照: ${err.message}`];
				this.lastWarnings = warnings;
				return { packs: this.snapshot.packs, warnings };
			}
			throw err;
		}
	}
}

/** 递归收集相关文件的 mtime 指纹（目录不存在/不可读跳过——loadPacks 负责报错）。 */
function collectMtimes(dirs: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const dir of dirs) {
		const stack = [dir];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			let entries;
			try {
				entries = readdirSync(cur, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const path = join(cur, entry.name);
				if (entry.isDirectory()) {
					stack.push(path);
				} else if (entry.isFile() && TRACKED_EXT.test(entry.name)) {
					try {
						out.set(path, statSync(path).mtimeMs);
					} catch {
						// 读不到 stat 的文件不追踪
					}
				}
			}
		}
	}
	return out;
}

function sameMtimes(a: Map<string, number>, b: Map<string, number>): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) {
		if (b.get(key) !== value) return false;
	}
	return true;
}
