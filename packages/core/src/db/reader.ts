// 读取 API 最小集（技术路线 §3.3：DB 层职责）。只读，无写途径。
// 按后续 pipeline 需要：clock 读取、turn_seq 范围查询、全表读、NPC 复合读。

import { DatabaseSync } from "node:sqlite";
import type { DirectiveRow, EventRow, NpcMemoryRow, NpcRelationRow, NpcRow, NpcTraitRow, PhaseRow, StoryClock, TimeLogRow, TurnLogRow, WorldStateRow } from "./types.ts";

export interface NpcComposite {
	npc: NpcRow | undefined;
	traits: NpcTraitRow[];
	memories: NpcMemoryRow[];
	relations: NpcRelationRow[];
}

export class DbReader {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	// ------------------------------------------------------------------
	// 时间
	// ------------------------------------------------------------------

	/** clock 单例读取。未初始化时返回 undefined（openStoryDb 会默认种入，见 story-db.ts）。
	 *  注意：current_time 是 SQLite 关键字（CURRENT_TIME），列引用必须限定表名或加引号。 */
	getClock(): StoryClock | undefined {
		return (
			(this.db
				.prepare(
					'SELECT "current_time", calendar, granularity FROM clock WHERE id = 1',
				)
				.get() as StoryClock | undefined) ?? undefined
		);
	}

	/** time_log 按轮次范围（含端点）。 */
	listTimeLog(options: { fromTurn?: number; toTurn?: number } = {}): TimeLogRow[] {
		const { where, params } = buildRangeWhere(options, "turn_seq");
		return this.db
			.prepare(`SELECT turn_seq, from_time, to_time, span_note FROM time_log${where} ORDER BY turn_seq`)
			.all(...params) as unknown as TimeLogRow[];
	}

	// ------------------------------------------------------------------
	// 叙事世界
	// ------------------------------------------------------------------

	/** events 全表/范围/类型查询（按 id 升序）。 */
	listEvents(options: { fromTurn?: number; toTurn?: number; type?: string } = {}): EventRow[] {
		const clauses: string[] = [];
		const params: Array<string | number> = [];
		if (options.fromTurn !== undefined) {
			clauses.push("turn_seq >= ?");
			params.push(options.fromTurn);
		}
		if (options.toTurn !== undefined) {
			clauses.push("turn_seq <= ?");
			params.push(options.toTurn);
		}
		if (options.type !== undefined) {
			clauses.push("type = ?");
			params.push(options.type);
		}
		const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
		return this.db
			.prepare(
				`SELECT id, turn_seq, story_time, type, summary, detail, participants, location, created_entry_id
				 FROM events${where} ORDER BY id`,
			)
			.all(...params) as unknown as EventRow[];
	}

	/** phases 全表读（按 started_turn 升序）。 */
	listPhases(): PhaseRow[] {
		return this.db
			.prepare("SELECT id, name, started_turn, ended_turn, goals, status FROM phases ORDER BY started_turn")
			.all() as unknown as PhaseRow[];
	}

	/** world_state 全表读（按 key 升序）。 */
	listWorldState(): WorldStateRow[] {
		return this.db.prepare("SELECT key, value, turn_seq FROM world_state ORDER BY key").all() as unknown as WorldStateRow[];
	}

	// ------------------------------------------------------------------
	// NPC
	// ------------------------------------------------------------------

	/** NPC 全表读（按 id 升序）。 */
	listNpcs(): NpcRow[] {
		return this.db.prepare("SELECT id, name, card_ref, status FROM npcs ORDER BY id").all() as unknown as NpcRow[];
	}

	/** NPC 复合读：基本信息 + 特征 + 记忆（按 salience 降序）+ 关系（双向）。 */
	getNpc(npcId: number): NpcComposite {
		const npc = this.db.prepare("SELECT id, name, card_ref, status FROM npcs WHERE id = ?").get(npcId) as
			| NpcRow
			| undefined;
		const traits = this.db
			.prepare("SELECT npc_id, trait, weight, source, turn_seq FROM npc_traits WHERE npc_id = ? ORDER BY turn_seq")
			.all(npcId) as unknown as NpcTraitRow[];
		const memories = this.db
			.prepare(
				"SELECT id, npc_id, turn_seq, kind, content, salience FROM npc_memories WHERE npc_id = ? ORDER BY salience DESC, id",
			)
			.all(npcId) as unknown as NpcMemoryRow[];
		const relations = this.db
			.prepare(
				"SELECT npc_a, npc_b, disposition, turn_seq FROM npc_relations WHERE npc_a = ? OR npc_b = ? ORDER BY turn_seq",
			)
			.all(npcId, npcId) as unknown as NpcRelationRow[];
		return { npc, traits, memories, relations };
	}

	// ------------------------------------------------------------------
	// 一致性 & 指令
	// ------------------------------------------------------------------

	/** turn_log 读取；不带 turnSeq 时返回全表（按 turn_seq 升序）。 */
	getTurnLog(turnSeq?: number): TurnLogRow[] {
		if (turnSeq !== undefined) {
			return this.db
				.prepare(
					"SELECT turn_seq, session_entry_id, user_input, narrative_text, raw_text FROM turn_log WHERE turn_seq = ?",
				)
				.all(turnSeq) as unknown as TurnLogRow[];
		}
		return this.db
			.prepare(
				"SELECT turn_seq, session_entry_id, user_input, narrative_text, raw_text FROM turn_log ORDER BY turn_seq",
			)
			.all() as unknown as TurnLogRow[];
	}

	/** directives 读取；status 过滤可选（默认全部）。 */
	listDirectives(status?: "active" | "done" | "revoked"): DirectiveRow[] {
		if (status !== undefined) {
			return this.db
				.prepare("SELECT id, turn_seq, content, status FROM directives WHERE status = ? ORDER BY id")
				.all(status) as unknown as DirectiveRow[];
		}
		return this.db.prepare("SELECT id, turn_seq, content, status FROM directives ORDER BY id").all() as unknown as DirectiveRow[];
	}
}

/** 组装 turn_seq 范围 WHERE（含端点）。 */
function buildRangeWhere(options: { fromTurn?: number; toTurn?: number }, column: string): { where: string; params: Array<number> } {
	const clauses: string[] = [];
	const params: number[] = [];
	if (options.fromTurn !== undefined) {
		clauses.push(`${column} >= ?`);
		params.push(options.fromTurn);
	}
	if (options.toTurn !== undefined) {
		clauses.push(`${column} <= ?`);
		params.push(options.toTurn);
	}
	return { where: clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}
