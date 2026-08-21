// 故事 DB 行类型与共享常量（创作规划 §5.1 schema 的结构化镜像）。

/** clock 单例（id=1）。不带 turn_seq —— 创作规划 §5.1 的显式例外。 */
export interface StoryClock {
	current_time: string;
	calendar: string;
	granularity: string;
}

/** 默认时钟初值。历法/粒度由卡包配置，默认弹性时间（§5.3）；具体初值待 M2 校准。 */
export const DEFAULT_STORY_CLOCK: StoryClock = {
	current_time: "0000-01-01",
	calendar: "default",
	granularity: "elastic",
};

/** 每轮时间推进记录（§5.3）。 */
export interface TimeLogRow {
	turn_seq: number;
	from_time: string;
	to_time: string;
	span_note: string | null;
}

/** 叙事事件。story_time = 事件发生的故事时间（§5.3 events.story_time 锚点）。
 *  location 自由文本留作叙事描述；location_id 引用 locations（登记校验，§5.1）。 */
export interface EventRow {
	id: number;
	turn_seq: number;
	story_time: string | null;
	type: string;
	summary: string;
	detail: string | null;
	participants: string | null;
	location: string | null;
	location_id: number | null;
	created_entry_id: string | null;
}

/** 故事阶段/幕。ended_turn 为 NULL 表示未结束。status 取值待 M2 校准。 */
export interface PhaseRow {
	id: number;
	name: string;
	started_turn: number;
	ended_turn: number | null;
	goals: string | null;
	status: string;
}

/** 世界状态键值（天气、经济等）。约定键 player_location = 玩家当前 location_id（§5.1）。 */
export interface WorldStateRow {
	key: string;
	value: string;
	turn_seq: number;
}

/** world_state 约定键：玩家当前所在地点 id（文本 = location_id）。 */
export const PLAYER_LOCATION_KEY = "player_location";

/** world_state 存的 location id 文本 → number | null（非法值返回 null）。 */
export function parseLocationId(value: string): number | null {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 地点注册表行（§5.1）。parent_id 表达包含关系（如 王城>庭院），不构成完整拓扑，内核不校验连通性。 */
export interface LocationRow {
	id: number;
	name: string;
	parent_id: number | null;
	detail: string | null;
	/** 父地点名（LEFT JOIN locations 解析；无父为 null）。 */
	parent_name: string | null;
}

/** 位置变更记录（§5.1，镜像 time_log）。subject = 'player' 或 'npc:<id>'。 */
export interface LocationLogRow {
	turn_seq: number;
	subject: string;
	from_location: number | null;
	to_location: number | null;
	note: string | null;
	/** 起点/终点地点名（LEFT JOIN 解析；null 表示起点为空或未登记）。 */
	from_location_name: string | null;
	to_location_name: string | null;
}

/** NPC。status: alive/dead/absent...（开放集合，待 M2 校准）。current_location 引用 locations。 */
export interface NpcRow {
	id: number;
	name: string;
	card_ref: string | null;
	status: string;
	current_location: number | null;
	/** 当前所在地点名（LEFT JOIN locations 解析）。 */
	current_location_name: string | null;
}

/** 性格特征，可演化 —— (npc_id, trait, turn_seq) 保留每次演化。weight 语义待 M2 校准。 */
export interface NpcTraitRow {
	npc_id: number;
	trait: string;
	weight: number;
	source: string | null;
	turn_seq: number;
}

/** 记忆；salience 供检索排序（默认 0，衰减语义待 M2 校准）。 */
export interface NpcMemoryRow {
	id: number;
	npc_id: number;
	turn_seq: number;
	kind: string;
	content: string;
	salience: number;
}

/** 关系/好感。disposition 参考 §5.2 favor 示例（-100~100，INTEGER）。 */
export interface NpcRelationRow {
	npc_a: number;
	npc_b: number;
	disposition: number;
	turn_seq: number;
}

/** 每轮一致性记录。raw_text = stylize 前原文（未启用则同 narrative_text）。
 *  warnings = §6.3 轻检/审查留痕（规则层硬冲突或 LLM 审查 findings 的文本摘要；可空，后补写）。 */
export interface TurnLogRow {
	turn_seq: number;
	session_entry_id: string;
	user_input: string;
	narrative_text: string;
	raw_text: string | null;
	warnings: string | null;
}

/** 创造模式剧情大纲指令（作者意图，非世界事实）。status 封闭枚举。 */
export interface DirectiveRow {
	id: number;
	turn_seq: number;
	content: string;
	status: "active" | "done" | "revoked";
}

/** data subagent 落库状态（§6.1 失败路径持久化；PK turn_seq）。
 *  status：ok = 落库成功；failed = 本轮失败待补；compensated = 后续轮补齐（含本轮事实）。 */
export interface DataStatusRow {
	turn_seq: number;
	status: "ok" | "failed" | "compensated";
	attempts: number;
	error: string | null;
}
