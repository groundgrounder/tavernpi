// 世界包类型（创作规划 §4 插件：世界包 / §4.1 M5 定稿）。
// 本模块是卡包加载 / 匹配 / seed 的共享类型底座。命名空间 = 包名（package.json name）：
// 加载即校验包名匹配 ^[a-z][a-z0-9_]*$（直接作 SQL 前缀，不做转换，见 §8 决策行「多卡命名空间」）。

/** 条目类型（目录即类型；collection/<type>/ 与 EntryType 一一对应）。 */
export const ENTRY_TYPES = ["character", "location", "object", "faction", "plot"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** 条目插入位置（§4.1 匹配语义 M5 定稿）：system（系统提示前部基调区）/ recent（贴近最新叙事）。 */
export const ENTRY_POSITIONS = ["system", "recent"] as const;
export type EntryPosition = (typeof ENTRY_POSITIONS)[number];

/** 包名校验（加载即校验，不转换；作 SQL 前缀用）。 */
export const PACK_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 条目 id 校验（文件名即条目 id）。 */
export const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * collection 条目（设定集加载形态）。
 * body = 注入用正文渲染（特化字段 → 紧凑 markdown）；summaryLine = refs 一级摘要行内容
 * （name + 首非空行截 60 字）；data = 该类型特化字段原始对象。
 */
export interface CollectionEntry {
	/** 所属包名（命名空间前缀）。 */
	pack: string;
	/** 条目 id（文件名去 .yaml；包内跨 type 唯一）。 */
	id: string;
	type: EntryType;
	name: string;
	/** 触发词（绿灯）；空 = 仅常驻/手动钉。 */
	keys: string[];
	/** 常驻（蓝灯）。 */
	alwaysOn: boolean;
	position: EntryPosition;
	/** 交叉引用 `[包名:]type:id`；注入时展开为一级摘要行（不递归）。 */
	refs: string[];
	/** 注入用正文渲染（由 matcher 逐条渲染进 {{collection_injection}}）。 */
	body: string;
	/** refs 一级摘要行内容 = name + 首非空行截 60 字。 */
	summaryLine: string;
	/** 该类型特化字段原始对象（character=identity/personality/voice?/dialogue_examples? 等）。 */
	data: Record<string, unknown>;
}

/** story.yaml 解析结果（本 lane 只解析进 StoryMeta；历法/开场白/文风消费在 Lane C）。 */
export interface StoryMeta {
	title?: string;
	calendar?: string;
	granularity?: string;
	opening?: string;
	defaultStyle?: string;
}

/** 世界包加载形态（§4.1 M5 定稿）。 */
export interface WorldPack {
	/** 包名（package.json name）。 */
	name: string;
	/** 包根目录（绝对路径）。 */
	dir: string;
	story: StoryMeta;
	entries: CollectionEntry[];
	/** 是否代码包（存在 index.ts 或 pi.extensions 声明）。 */
	hasCode: boolean;
	/** 代码入口路径（index.ts / pi.extensions 指向的 extension entry，已解析为绝对路径；本 lane 不加载）。 */
	extensionEntryPaths: string[];
}

/** 加载问题（报错到人；file 提供时带文件名定位）。 */
export interface PackIssue {
	file?: string;
	message: string;
}

/** 加载失败：收集全部问题一次性抛出（供校验工具/UI 展示；含文件名）。 */
export class PackLoadError extends Error {
	readonly issues: PackIssue[];
	constructor(issues: PackIssue[]) {
		super(issues.map((i) => (i.file !== undefined ? `${i.file}: ${i.message}` : i.message)).join("\n"));
		this.name = "PackLoadError";
		this.issues = issues;
	}
}
