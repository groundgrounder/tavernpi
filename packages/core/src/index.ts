// tavernpi-core 对外导出收敛（创作规划 §10.2 API 承诺面的源头）。
// M1-P1：故事 DB 层；M1-P2：快照管理器（§3.1 ★承重机制）；M2-P1：提示词分层/subagent 运行时/
// pipeline 事件流/模型配置最小形态。

export const CORE_VERSION = "0.0.0";

// 故事目录与打开
export {
	defaultStoriesRoot,
	openStoryDb,
	storyDbPath,
	StoryDb,
	type StoryDb as StoryDbHandle,
} from "./db/story-db.ts";

// migration 框架
export { CORE_MIGRATIONS, hasMigration, migrate, type Migration } from "./db/migrate.ts";

// 读写层
export { DbReader, type NpcComposite } from "./db/reader.ts";
export { DbWriter } from "./db/writer.ts";

// db 工具集（pi ToolDefinition）
export { createDbTools, type DbToolsOptions } from "./db/tools.ts";

// 行类型与常量
export {
	DEFAULT_STORY_CLOCK,
	PLAYER_LOCATION_KEY,
	parseLocationId,
	type DirectiveRow,
	type EventRow,
	type LocationLogRow,
	type LocationRow,
	type NpcMemoryRow,
	type NpcRelationRow,
	type NpcRow,
	type NpcTraitRow,
	type PhaseRow,
	type StoryClock,
	type TimeLogRow,
	type TurnLogRow,
	type WorldStateRow,
} from "./db/types.ts";

// schema 常量（迁移测试/卡包工具可用）
export { CORE_SCHEMA_SQL, CORE_V2_ALTERS, CORE_V2_SPATIAL_SQL } from "./db/schema.ts";

// 快照管理器（§3.1 ★）
export {
	openSnapshotsDb,
	snapshotsDbPath,
	takeSnapshot,
	SnapshotsDb,
	type SnapshotRecord,
} from "./snapshot/snapshots-db.ts";
export { removeWalFiles, resetToEmptyStoryDb, restoreSnapshot } from "./snapshot/restore.ts";
export { buildAncestorChain, type EntryLike } from "./snapshot/ancestors.ts";
export {
	createSnapshotHooks,
	type PendingRestore,
	type SnapshotHooks,
	type SnapshotHooksOptions,
	type SnapshotHookState,
	type SnapshotRestoreResult,
} from "./snapshot/hooks.ts";
export { forkStoryDb, type ForkResult } from "./snapshot/fork.ts";

// 轮中交互通道（§6.7）
export {
	InteractionBroker,
	InteractionUnavailableError,
	InteractionValidationError,
	InteractionTimeoutError,
	judgeCombat,
} from "./interaction/index.ts";
export type {
	CombatDifficulty,
	CombatJudgement,
	CombatJudgementInput,
	CombatOutcome,
	InteractionHandler,
	InteractionRequest,
} from "./interaction/index.ts";

// 提示词分层加载器（§6.5）
export {
	builtinPromptsDir,
	defaultGlobalPromptsDir,
	loadPrompt,
	renderPlaceholders,
	type LoadedPrompt,
	type PlaceholderRender,
	type PromptLayer,
	type PromptLayerDirs,
} from "./prompts/loader.ts";

// subagent 运行时（§6.0 总则 / 技术路线 §3.3）
export {
	runSubagent,
	SubagentOutputError,
	type SubagentOutputTool,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "./subagent/runtime.ts";

// pipeline 事件流（§10.2 承诺面 M2 起）
export {
	createPipelineEventLog,
	type PipelineEvent,
	type PipelineEventLog,
	type PipelineEventListener,
} from "./pipeline/events.ts";

// 模型配置最小形态（§6.6）
export {
	defaultSettingsPath,
	loadSettings,
	type ModelRef,
	type TavernModels,
	type TavernSettings,
} from "./settings.ts";
