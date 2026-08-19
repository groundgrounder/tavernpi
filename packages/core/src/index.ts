// tavernpi-core 对外导出收敛（创作规划 §10.2 API 承诺面的源头）。
// M1-P1：故事 DB 层。

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
	type DirectiveRow,
	type EventRow,
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
