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

/** 叙事事件。story_time = 事件发生的故事时间（§5.3 events.story_time 锚点）。 */
export interface EventRow {
	id: number;
	turn_seq: number;
	story_time: string | null;
	type: string;
	summary: string;
	detail: string | null;
	participants: string | null;
	location: string | null;
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

/** 世界状态键值（天气、经济等）。 */
export interface WorldStateRow {
	key: string;
	value: string;
	turn_seq: number;
}

/** NPC。status: alive/dead/absent...（开放集合，待 M2 校准）。 */
export interface NpcRow {
	id: number;
	name: string;
	card_ref: string | null;
	status: string;
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

/** 每轮一致性记录。raw_text = stylize 前原文（未启用则同 narrative_text）。 */
export interface TurnLogRow {
	turn_seq: number;
	session_entry_id: string;
	user_input: string;
	narrative_text: string;
	raw_text: string | null;
}

/** 创造模式剧情大纲指令（作者意图，非世界事实）。status 封闭枚举。 */
export interface DirectiveRow {
	id: number;
	turn_seq: number;
	content: string;
	status: "active" | "done" | "revoked";
}
