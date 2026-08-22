// tavernpi-core 对外导出收敛（创作规划 §10.2 API 承诺面的源头）。
// M1-P1：故事 DB 层；M1-P2：快照管理器（§3.1 ★承重机制）；M2-P1：提示词分层/subagent 运行时/
// pipeline 事件流/模型配置最小形态；M2-P2：data subagent（§6.1）+ StoryRuntime 编排器（§10.2）；
// M3-P2：npc subagent 阶段（§6.2）接入 StoryRuntime；M4-P2：story 阶段（§6.3）+ stylize（§6.4）接入。

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
	type DataStatusRow,
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
export { CORE_SCHEMA_SQL, CORE_V2_ALTERS, CORE_V2_SPATIAL_SQL, CORE_V3_DATA_STATUS_SQL } from "./db/schema.ts";

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

// data subagent 变更集（§6.1）
export {
	applyChangeset,
	CHANGELOG_JSON_SCHEMA,
	changesetZodSchema,
	filterConflictingItems,
	validateChangesetSemantics,
	type ApplySummary,
	type Changeset,
	type ChangesetProblem,
} from "./pipeline/changeset.ts";

// DB 摘要渲染（§5.2）
export { renderDbSummary } from "./pipeline/db-summary.ts";

// data subagent 编排（§6.1）
export {
	DATA_OUTPUT_TOOL_NAME,
	runDataStage,
	type DataStageInput,
	type DataStageOptions,
	type DataStageOutcome,
} from "./pipeline/data-stage.ts";

// npc subagent（§6.2：场景规划 / 在场预演 / 离线推演 / 渲染器 / 簿记键）
// isReservedWorldStateKey 从 changeset 重导出：sys_ 前缀命名空间是 npc 簿记键的权威判定
//（data 禁写内核保留键，见 changeset.ts），归属 npc 节更贴合其用途。
export { isReservedWorldStateKey } from "./pipeline/changeset.ts";
export {
	OFFSCREEN_LAST_TURN_PREFIX,
	OFFSCREEN_OUTPUT_TOOL_NAME,
	ONSTAGE_OUTPUT_TOOL_NAME,
	computeScenePlan,
	offscreenLastTurnKey,
	renderOffscreenDeltasForData,
	renderRehearsals,
	runOffscreenBatch,
	runOnstageRehearsals,
	type NpcRehearsal,
	type NpcStageOptions,
	type OffscreenBatch,
	type OffscreenDelta,
	type ScenePlan,
} from "./pipeline/npc-stage.ts";

// story subagent（§6.3：场景分析 / 规则层轻检 / LLM 审查 / 全统筹 / 渲染器）
export {
	OVERSEE_JSON_SCHEMA,
	OVERSEE_OUTPUT_TOOL_NAME,
	REVIEW_JSON_SCHEMA,
	REVIEW_OUTPUT_TOOL_NAME,
	SCENE_CARD_JSON_SCHEMA,
	SCENE_OUTPUT_TOOL_NAME,
	buildFallbackSceneCard,
	overseeZodSchema,
	renderOverseeNote,
	renderRevisionRequest,
	renderSceneCardForNarrator,
	reviewZodSchema,
	runOversee,
	runReview,
	runRuleChecks,
	runSceneAnalysis,
	sceneCardZodSchema,
	validateSceneCard,
	type OverseeNote,
	type ReviewFinding,
	type RuleCheckInput,
	type RuleCheckResult,
	type SceneAnalysisResult,
	type SceneCard,
	type StoryStageOptions,
} from "./pipeline/story-stage.ts";

// stylize（§6.4：默认关闭的可选阶段；零事实漂移抽查）
export {
	STYLIZE_JSON_SCHEMA,
	STYLIZE_OUTPUT_TOOL_NAME,
	runStylize,
	stylizeFactCheck,
	stylizeZodSchema,
	type StylizeOptions,
	type StylizeOutput,
} from "./pipeline/stylize-stage.ts";

// StoryRuntime 编排器（§10.2 API 面 M2 形态 + §6.2 npc 阶段 + §6.3 story 阶段 + §6.4 stylize）
export {
	computeNextTurnSeq,
	createStoryRuntime,
	findUserEntryOnBranch,
	type NpcStageRuntimeOptions,
	type StoryRuntime,
	type StoryRuntimeOptions,
	type StoryStageRuntimeOptions,
	type StoryState,
	type StylizeRuntimeOptions,
	type TurnResult,
} from "./pipeline/runtime.ts";

// 卡包系统（§4 世界包：加载 / 匹配注入 / seed / mtime 缓存热更新；§4.1 M5 定稿）
export { loadPack, loadPacks, KERNEL_TABLE_WHITELIST } from "./pack/loader.ts";
export { PackCache } from "./pack/cache.ts";
export {
	buildCollectionInjection,
	estimateTokens,
	type CollectionInjectionOptions,
	type CollectionInjectionResult,
} from "./pack/matcher.ts";
export { packMigrations } from "./pack/seed.ts";
export {
	PackLoadError,
	ENTRY_ID_RE,
	ENTRY_POSITIONS,
	ENTRY_TYPES,
	PACK_NAME_RE,
	type CollectionEntry,
	type EntryPosition,
	type EntryType,
	type PackIssue,
	type StoryMeta,
	type WorldPack,
} from "./pack/types.ts";

// 故事创建（§4.1 M5：createStory——卡包校验 → SQL+seed 迁移 → story.yaml 消费 → 开场白首轮 → story.meta.json）
export {
	createStory,
	type CreateStoryOptions,
	type CreateStoryResult,
	type StoryMetaFile,
} from "./story.ts";
