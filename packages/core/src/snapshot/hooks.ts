// pi 钩子薄适配层（§3.1 快照恢复挂载点，设计前提 #1/#2）。
// 分工：
//   session_before_tree（支持 cancel）：定位目标 entry 祖先链 + 校验快照存在性，
//     找不到快照 → 空库兜底（仅限无历史的新故事，见下）或判失败。此阶段不 cancel，
//     只做准备与校验，把「待恢复快照」存入带外状态。
//   session_tree（handler 异常会被 pi 吞掉）：执行原子恢复；失败**不能依赖异常传播**，
//     结果显式写入 state.lastRestoreResult，失败时重开旧库回容器（防死句柄楔死），
//     并保持失败标志置位供上层 UI 警示。

import type { ExtensionContext, SessionBeforeTreeEvent, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { openStoryDb, type StoryDb } from "../db/story-db.ts";
import { resetToEmptyStoryDb, restoreSnapshot } from "./restore.ts";
import type { SnapshotsDb } from "./snapshots-db.ts";

/** 带外待恢复状态：一次导航准备阶段的产物。 */
export type PendingRestore =
	| { kind: "snapshot"; dump: Uint8Array; turnSeq: number; sessionEntryId: string }
	| { kind: "empty" }
	/** 判为失败（如祖先链无快照但故事已有历史——外部损伤场景），tree 阶段不触碰库。 */
	| { kind: "failed"; error: string };

export interface SnapshotRestoreResult {
	ok: boolean;
	error?: string;
	restoredTurnSeq?: number;
	restoredEntryId?: string;
}

export interface SnapshotHookState {
	/** 最近一次导航的恢复结果（session_tree 执行后更新）。 */
	lastRestoreResult: SnapshotRestoreResult | undefined;
	/** 空库兜底等 warning 记录（保留最近 WARNINGS_LIMIT 条）。 */
	warnings: string[];
}

const WARNINGS_LIMIT = 50;

export interface SnapshotHooksOptions {
	snapshotsDb: SnapshotsDb;
	/** 当前 story db（恢复后会被替换）。 */
	getStoryDb: () => StoryDb;
	/** 恢复后回写新 StoryDb 实例（恢复 = 重开新实例，见 restore.ts 取舍说明）。 */
	setStoryDb: (storyDb: StoryDb) => void;
	/** 目标 entry 的祖先链（近→远，含自身）；编排层从 pi entries 沿 parentId 构建。 */
	getEntryAncestors: (entryId: string) => string[];
	onWarning?: (message: string) => void;
	/** 恢复执行器（默认 restoreSnapshot / resetToEmptyStoryDb）。测试与编排可注入。 */
	restoreImpl?: (storyDb: StoryDb, pending: PendingRestore) => StoryDb;
}

export interface SnapshotHooks {
	state: SnapshotHookState;
	sessionBeforeTree: (event: SessionBeforeTreeEvent, ctx: ExtensionContext) => void;
	sessionTree: (event: SessionTreeEvent, ctx: ExtensionContext) => void;
}

export function createSnapshotHooks(options: SnapshotHooksOptions): SnapshotHooks {
	const state: SnapshotHookState = { lastRestoreResult: undefined, warnings: [] };
	const restoreImpl = options.restoreImpl ?? defaultRestoreImpl;
	let pending: PendingRestore | undefined;

	function pushWarning(message: string): void {
		state.warnings.push(message);
		if (state.warnings.length > WARNINGS_LIMIT) {
			state.warnings = state.warnings.slice(-WARNINGS_LIMIT);
		}
		options.onWarning?.(message);
	}

	const sessionBeforeTree = (event: SessionBeforeTreeEvent): void => {
		// 入口先清 pending：防本 handler 抛错（被 pi 吞掉）后 session_tree 消费上一次遗留的
		// stale pending（双故障窗口）。
		pending = undefined;

		const targetId = event.preparation.targetId;
		const ancestors = options.getEntryAncestors(targetId);
		const nearest = options.snapshotsDb.findNearestSnapshot(ancestors);
		if (nearest) {
			pending = {
				kind: "snapshot",
				dump: nearest.dump,
				turnSeq: nearest.turn_seq,
				sessionEntryId: nearest.session_entry_id,
			};
			return;
		}

		// 祖先链无快照。区分两种语义（§3.1 + M1-P2 gate m3）：
		// - 故事尚无历史（turn_log 为空，首轮前/全新故事）：空库初始状态兜底；
		// - 故事已有历史但快照全无（外部损伤场景）：判恢复失败，拒绝静默擦成空库。
		const turnLogCount = options.getStoryDb().reader.getTurnLog().length;
		if (turnLogCount > 0) {
			const message = `祖先链无快照但 turn_log 非空（${turnLogCount} 轮）——疑似外部损伤，拒绝空库兜底，保持当前库不动`;
			pending = { kind: "failed", error: message };
			pushWarning(message);
			return;
		}
		pending = { kind: "empty" };
		const message = `未找到 entry ${targetId} 祖先链上的快照，本次导航恢复走空库兜底（§3.1）`;
		pushWarning(message);
	};

	const sessionTree = (): void => {
		const currentPending = pending;
		pending = undefined; // 一次性消费
		if (!currentPending) {
			state.lastRestoreResult = {
				ok: false,
				error: "session_tree 触发时无待恢复快照（session_before_tree 未先执行、抛错或已消费）",
			};
			return;
		}
		if (currentPending.kind === "failed") {
			// 判失败的 pending：不触碰库，只记录
			state.lastRestoreResult = { ok: false, error: currentPending.error };
			return;
		}
		try {
			const current = options.getStoryDb();
			const restored = restoreImpl(current, currentPending);
			options.setStoryDb(restored);
			state.lastRestoreResult =
				currentPending.kind === "snapshot"
					? {
							ok: true,
							restoredTurnSeq: currentPending.turnSeq,
							restoredEntryId: currentPending.sessionEntryId,
						}
					: { ok: true };
		} catch (error) {
			// 为什么 try/catch 内自吞并落状态：session_tree handler 异常会被 pi 的 emit()
			// 吞掉（技术路线 §3.2 实证），异常传播不可靠。恢复失败必须显式写入
			// lastRestoreResult 供上层 UI 警示；rename 前旧库文件未被触碰。
			const message = error instanceof Error ? error.message : String(error);
			state.lastRestoreResult = { ok: false, error: message };
			// 死句柄回退（M1 条件项）：restoreSnapshot 消费（关闭）了传入句柄——失败后必须
			// 用 openStoryDb 重开旧库并回容器，否则 reader/writer 再调即抛 database is not open，
			// 系统楔死。重开若也失败，错误并入 lastRestoreResult。
			try {
				const current = options.getStoryDb();
				const revived = openStoryDb(current.path);
				options.setStoryDb(revived);
			} catch (reviveError) {
				const reviveMessage = reviveError instanceof Error ? reviveError.message : String(reviveError);
				state.lastRestoreResult = { ok: false, error: `${message}；且重开旧库失败: ${reviveMessage}` };
			}
		}
	};

	return { state, sessionBeforeTree, sessionTree };
}

function defaultRestoreImpl(storyDb: StoryDb, pending: PendingRestore): StoryDb {
	if (pending.kind === "snapshot") {
		return restoreSnapshot(storyDb, pending.dump);
	}
	return resetToEmptyStoryDb(storyDb);
}
