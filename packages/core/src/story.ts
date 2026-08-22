// 故事创建 API（创作规划 §7 M5 / §4.1：createStory 故事创建：卡包加载校验 → 建故事目录 →
// openStoryDb/openSnapshotsDb → 卡包 SQL+条目 seed 迁移 → story.yaml 消费（历法/粒度写 clock、
// 开场白首轮 assistant + turn_log 0 + 初始快照）→ story.meta.json）。
//
// 与 m4-cli 的 storyDir 约定一致：sessionId 由 SessionManager.create 生成，
// 故事目录 = <storiesRoot>/<sessionId>/（story.db + snapshots.db + story.meta.json）。
//
// 卡包迁移调用形式沿 packages/tools/src/cli.ts：migrate(db) 已含 core（openStoryDb 已跑），
// 这里逐包 migrate(db, [m]) 应用 <包名>_schema / <包名>_seed（schema_migrations 追踪，幂等有序）。
//
// TODO(M6)：包代码接线——WorldPack.extensionEntryPaths → createAgentSession 的
// additionalExtensionPaths（技术路线 §3.1「代码包 extension 经 SDK 委托 pi loader 执行」）；
// 本 lane（M5）只接注入层，代码包挂载点待 M6 模式设计定案（创作规划 §4.1 加载形态）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_STORY_CLOCK } from "./db/types.ts";
import { defaultStoriesRoot, openStoryDb, storyDbPath } from "./db/story-db.ts";
import { migrate } from "./db/migrate.ts";
import { openSnapshotsDb, snapshotsDbPath, takeSnapshot } from "./snapshot/snapshots-db.ts";
import { loadPacks } from "./pack/loader.ts";
import { packMigrations } from "./pack/seed.ts";
import type { StoryMeta, WorldPack } from "./pack/types.ts";
import type { StoryState } from "./pipeline/runtime.ts";

export interface CreateStoryOptions {
	/** 故事根目录（缺省 ~/.tavernpi/stories）。 */
	storiesRoot?: string;
	/** 卡包目录（可空 = 无包故事）。 */
	packDirs: string[];
	cwd: string;
	/** 故事标题（覆盖 story.yaml title，写 story.meta.json）。 */
	title?: string;
}

/** story.meta.json 内容（--resume 恢复 packDirs / stylize defaultStyle 的载体）。 */
export interface StoryMetaFile {
	title?: string;
	packs: Array<{ name: string; dir: string; version?: string }>;
	defaultStyle?: string;
	createdAt: string;
}

export interface CreateStoryResult {
	sessionId: string;
	storyDir: string;
	sessionManager: SessionManager;
	storyState: StoryState;
	packs: WorldPack[];
}

/** story.yaml 的历法/粒度/开场白/文风字段（StoryMeta 消费面）。 */
const STORY_META_FIELDS = ["title", "calendar", "granularity", "opening", "defaultStyle"] as const;

/**
 * 创建新故事：加载校验 → 建目录/DB → 卡包迁移 → story.yaml 消费 → 开场白首轮 → 元数据。
 * 加载失败（PackLoadError）在创建任何文件之前抛出（fail fast，不留下半成品故事目录）。
 */
export async function createStory(opts: CreateStoryOptions): Promise<CreateStoryResult> {
	const storiesRoot = opts.storiesRoot ?? defaultStoriesRoot();
	// 1) 加载 + 全量校验先行（zod strict / 引用完整性 / 前缀静态扫描 / id 冲突）
	const dirs = opts.packDirs.map((d) => resolve(d));
	const packs = dirs.length > 0 ? loadPacks(dirs) : [];

	// 2) session 与故事目录（sessionId 生成沿用 m4-cli：SessionManager.create 到 <storiesRoot>/sessions）
	const sessionManager = SessionManager.create(opts.cwd, join(storiesRoot, "sessions"));
	const sessionId = sessionManager.getSessionId();
	const storyDir = join(storiesRoot, sessionId);
	mkdirSync(storyDir, { recursive: true });

	// 3) 打开 DB（openStoryDb 已跑 core 迁移并种入默认 clock）
	const storyDb = openStoryDb(storyDbPath(storiesRoot, sessionId));
	const snapshotsDb = openSnapshotsDb(snapshotsDbPath(storyDb.path));

	try {
		// 4) 卡包 SQL + 条目 seed：命名迁移逐包应用（schema_migrations 追踪；seed 幂等）
		for (const m of packMigrations(packs)) {
			migrate(storyDb.rawDb, [m]);
		}

		// 5) story.yaml 消费：历法/粒度写 clock 初值（§5.3；多包时按包序取先定义者）
		const story = mergeStoryMeta(packs);
		if (story.calendar !== undefined || story.granularity !== undefined) {
			const clock = storyDb.reader.getClock() ?? DEFAULT_STORY_CLOCK;
			storyDb.writer.upsertClock({
				current_time: clock.current_time,
				calendar: story.calendar ?? clock.calendar,
				granularity: story.granularity ?? clock.granularity,
			});
		}

		// 6) 开场白（§4.1）：首轮 assistant 消息（session 树根）+ turn_log(turnSeq=0) + 初始快照。
		//    初始快照绑定 opening entry——导航到首条 user 消息时 newLeaf = opening entry，
		//    祖先链命中该快照 → 恢复到「开场白后」初始态（§3.1 首 user 空库兜底的替代：有开场白的
		//    故事其「初始态」就是开场白后的世界，不该清空 seed）。
		if (story.opening !== undefined && story.opening.trim() !== "") {
			const opening = story.opening.trim();
			const openingEntryId = appendOpeningMessage(sessionManager, opening);
			storyDb.writer.recordTurnLog({
				turnSeq: 0,
				sessionEntryId: openingEntryId,
				userInput: "（开场白）",
				narrativeText: opening,
			});
			await takeSnapshot(storyDb, { turnSeq: 0, sessionEntryId: openingEntryId });
		}

		// 7) 故事元数据（--resume 恢复 packDirs / stylize defaultStyle 读取）
		const meta: StoryMetaFile = {
			...(opts.title !== undefined
				? { title: opts.title }
				: story.title !== undefined
					? { title: story.title }
					: {}),
			packs: packs.map((p) => ({ name: p.name, dir: p.dir, ...readPackVersion(p.dir) })),
			...(story.defaultStyle !== undefined ? { defaultStyle: story.defaultStyle } : {}),
			createdAt: new Date().toISOString(),
		};
		writeFileSync(join(storyDir, "story.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
	} catch (error) {
		storyDb.close();
		snapshotsDb.close();
		throw error;
	}

	return {
		sessionId,
		storyDir,
		sessionManager,
		storyState: { storyDir, storyDb, snapshotsDb },
		packs,
	};
}

/** 多包 story.yaml 消费：按包序取每个字段的「先定义者」（title/calendar/granularity/opening/defaultStyle）。 */
function mergeStoryMeta(packs: WorldPack[]): StoryMeta {
	const merged: StoryMeta = {};
	for (const pack of packs) {
		for (const field of STORY_META_FIELDS) {
			if (merged[field] === undefined && pack.story[field] !== undefined) {
				merged[field] = pack.story[field];
			}
		}
	}
	return merged;
}

/** 开场白落 session：首轮 assistant 消息（pi session 树根，无父）。返回 entry id。 */
function appendOpeningMessage(sessionManager: SessionManager, opening: string): string {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: opening }],
		api: "pi-messages",
		provider: "tavernpi",
		model: "story-opening",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as Parameters<SessionManager["appendMessage"]>[0];
	return sessionManager.appendMessage(message);
}

/** 读包 package.json 的 version（best-effort；读不到省略字段）。 */
function readPackVersion(dir: string): { version: string } | {} {
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? { version: pkg.version } : {};
	} catch {
		return {};
	}
}
