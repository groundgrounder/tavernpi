// 写者（唯一写路径）。turn_seq 纪律（技术路线 §6 / 创作规划 §5.1）：
// - 所有带 turn_seq 的表的写入方法**必须显式传 turnSeq**（类型层面必填，无默认值）；
// - prepared statement 全部私有，业务代码无途径绕过纪律；
// - clock 是唯一例外（upsertClock 单例，不带 turn_seq，历史走 time_log）。

import { DatabaseSync } from "node:sqlite";
import { DEFAULT_STORY_CLOCK, type DirectiveRow, type EventRow, type NpcMemoryRow, type NpcRelationRow, type NpcRow, type NpcTraitRow, type PhaseRow, type StoryClock, type TimeLogRow, type TurnLogRow, type WorldStateRow } from "./types.ts";

/** turn_seq 运行时校验（类型层面已强制；此为纵深防御，覆盖 JS 调用与缺参）。 */
function assertTurnSeq(turnSeq: unknown): asserts turnSeq is number {
	if (typeof turnSeq !== "number" || !Number.isSafeInteger(turnSeq) || turnSeq < 0) {
		throw new TypeError(
			`turn_seq 纪律：写入 API 必须显式传非负整数 turnSeq，收到 ${String(turnSeq)}`,
		);
	}
}

export class DbWriter {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	// ------------------------------------------------------------------
	// 时间（§5.3）
	// ------------------------------------------------------------------

	/** 更新 clock 单例（id=1）。turn_seq 纪律的显式例外；历史经 advanceClock 写 time_log。
	 *  current_time 是 SQLite 关键字，INSERT 列名加引号限定。 */
	upsertClock(clock: StoryClock): void {
		this.db
			.prepare(
				`INSERT INTO clock (id, "current_time", calendar, granularity) VALUES (1, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   "current_time" = excluded."current_time",
				   calendar = excluded.calendar,
				   granularity = excluded.granularity`,
			)
			.run(clock.current_time, clock.calendar, clock.granularity);
	}

	/**
	 * 推进时间：写 time_log（from→to）并同步 clock 单例。spanNote = 时间跨度说明。
	 * from_time 由 writer 内部读取 clock 单例的当前值 —— time_log.from_time 必须
	 * ≡ 写入时 clock.current_time，来源一致由 DB 层保证，调用方无参数可伪造。
	 *
	 * 注意：「不倒流」校验刻意**不在 DB 层**——历法可插拔（§5.3），TEXT 时间比较不可靠，
	 * 属 pipeline 层职责。防后人误加 DB 层时间序校验。
	 */
	advanceClock(input: { turnSeq: number; toTime: string; spanNote?: string }): TimeLogRow {
		assertTurnSeq(input.turnSeq);
		const cur = this.db
			.prepare('SELECT "current_time", calendar, granularity FROM clock WHERE id = 1')
			.get() as StoryClock | undefined;
		const fromTime = cur?.current_time ?? DEFAULT_STORY_CLOCK.current_time;
		this.db
			.prepare("INSERT INTO time_log (turn_seq, from_time, to_time, span_note) VALUES (?, ?, ?, ?)")
			.run(input.turnSeq, fromTime, input.toTime, input.spanNote ?? null);
		this.upsertClock({
			current_time: input.toTime,
			calendar: cur?.calendar ?? DEFAULT_STORY_CLOCK.calendar,
			granularity: cur?.granularity ?? DEFAULT_STORY_CLOCK.granularity,
		});
		return {
			turn_seq: input.turnSeq,
			from_time: fromTime,
			to_time: input.toTime,
			span_note: input.spanNote ?? null,
		};
	}

	// ------------------------------------------------------------------
	// 叙事世界
	// ------------------------------------------------------------------

	/** 追加事件。type 默认 'event'（取值词汇待 M2 校准）。 */
	insertEvent(input: {
		turnSeq: number;
		summary: string;
		detail?: string;
		storyTime?: string;
		type?: string;
		participants?: string;
		location?: string;
		createdEntryId?: string;
	}): EventRow {
		assertTurnSeq(input.turnSeq);
		const res = this.db
			.prepare(
				`INSERT INTO events (turn_seq, story_time, type, summary, detail, participants, location, created_entry_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.turnSeq,
				input.storyTime ?? null,
				input.type ?? "event",
				input.summary,
				input.detail ?? null,
				input.participants ?? null,
				input.location ?? null,
				input.createdEntryId ?? null,
			);
		return {
			id: Number(res.lastInsertRowid),
			turn_seq: input.turnSeq,
			story_time: input.storyTime ?? null,
			type: input.type ?? "event",
			summary: input.summary,
			detail: input.detail ?? null,
			participants: input.participants ?? null,
			location: input.location ?? null,
			created_entry_id: input.createdEntryId ?? null,
		};
	}

	/** 新建故事阶段/幕。phases 表无 turn_seq 列，startedTurn 记录起始轮次。 */
	insertPhase(input: { name: string; startedTurn: number; goals?: string; status?: string }): PhaseRow {
		assertTurnSeq(input.startedTurn);
		const res = this.db
			.prepare("INSERT INTO phases (name, started_turn, goals, status) VALUES (?, ?, ?, ?)")
			.run(input.name, input.startedTurn, input.goals ?? null, input.status ?? "active");
		return {
			id: Number(res.lastInsertRowid),
			name: input.name,
			started_turn: input.startedTurn,
			ended_turn: null,
			goals: input.goals ?? null,
			status: input.status ?? "active",
		};
	}

	/** 结束阶段：写入 ended_turn。status 语义由调用方另行处理（待 M2 校准）。 */
	endPhase(phaseId: number, endedTurn: number): void {
		assertTurnSeq(endedTurn);
		this.db.prepare("UPDATE phases SET ended_turn = ? WHERE id = ?").run(endedTurn, phaseId);
	}

	/** 更新世界状态键值（同 key 覆盖，保留最新 turn_seq）。 */
	upsertWorldState(input: { key: string; value: string; turnSeq: number }): WorldStateRow {
		assertTurnSeq(input.turnSeq);
		this.db
			.prepare(
				`INSERT INTO world_state (key, value, turn_seq) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, turn_seq = excluded.turn_seq`,
			)
			.run(input.key, input.value, input.turnSeq);
		return { key: input.key, value: input.value, turn_seq: input.turnSeq };
	}

	// ------------------------------------------------------------------
	// NPC
	// ------------------------------------------------------------------

	/** 新建 NPC（npcs 表无 turn_seq 列）。 */
	insertNpc(input: { name: string; cardRef?: string; status?: string }): NpcRow {
		const res = this.db
			.prepare("INSERT INTO npcs (name, card_ref, status) VALUES (?, ?, ?)")
			.run(input.name, input.cardRef ?? null, input.status ?? "alive");
		return {
			id: Number(res.lastInsertRowid),
			name: input.name,
			card_ref: input.cardRef ?? null,
			status: input.status ?? "alive",
		};
	}

	/** 更新 NPC 状态（alive/dead/absent...，开放集合待 M2 校准）。 */
	updateNpcStatus(npcId: number, status: string): void {
		this.db.prepare("UPDATE npcs SET status = ? WHERE id = ?").run(status, npcId);
	}

	/** 写入性格特征。同轮同 trait 重复写触发主键冲突（写者纪律保护）。 */
	insertNpcTrait(input: { npcId: number; trait: string; weight: number; source?: string; turnSeq: number }): NpcTraitRow {
		assertTurnSeq(input.turnSeq);
		this.db
			.prepare("INSERT INTO npc_traits (npc_id, trait, weight, source, turn_seq) VALUES (?, ?, ?, ?, ?)")
			.run(input.npcId, input.trait, input.weight, input.source ?? null, input.turnSeq);
		return {
			npc_id: input.npcId,
			trait: input.trait,
			weight: input.weight,
			source: input.source ?? null,
			turn_seq: input.turnSeq,
		};
	}

	/** 写入记忆。salience 默认 0（衰减语义待 M2 校准）。 */
	insertNpcMemory(input: { npcId: number; turnSeq: number; kind: string; content: string; salience?: number }): NpcMemoryRow {
		assertTurnSeq(input.turnSeq);
		const res = this.db
			.prepare("INSERT INTO npc_memories (npc_id, turn_seq, kind, content, salience) VALUES (?, ?, ?, ?, ?)")
			.run(input.npcId, input.turnSeq, input.kind, input.content, input.salience ?? 0);
		return {
			id: Number(res.lastInsertRowid),
			npc_id: input.npcId,
			turn_seq: input.turnSeq,
			kind: input.kind,
			content: input.content,
			salience: input.salience ?? 0,
		};
	}

	/** 写入关系/好感。(npc_a, npc_b, turn_seq) 主键保留演化。 */
	insertNpcRelation(input: { npcA: number; npcB: number; disposition: number; turnSeq: number }): NpcRelationRow {
		assertTurnSeq(input.turnSeq);
		this.db
			.prepare("INSERT INTO npc_relations (npc_a, npc_b, disposition, turn_seq) VALUES (?, ?, ?, ?)")
			.run(input.npcA, input.npcB, input.disposition, input.turnSeq);
		return {
			npc_a: input.npcA,
			npc_b: input.npcB,
			disposition: input.disposition,
			turn_seq: input.turnSeq,
		};
	}

	// ------------------------------------------------------------------
	// 一致性
	// ------------------------------------------------------------------

	/** 记录每轮一致性条目（PK turn_seq，每轮一行）。rawText 缺省回退 narrativeText（stylize 语义，§6.4）。 */
	recordTurnLog(input: {
		turnSeq: number;
		sessionEntryId: string;
		userInput: string;
		narrativeText: string;
		rawText?: string;
	}): TurnLogRow {
		assertTurnSeq(input.turnSeq);
		this.db
			.prepare(
				"INSERT INTO turn_log (turn_seq, session_entry_id, user_input, narrative_text, raw_text) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				input.turnSeq,
				input.sessionEntryId,
				input.userInput,
				input.narrativeText,
				input.rawText ?? null,
			);
		return {
			turn_seq: input.turnSeq,
			session_entry_id: input.sessionEntryId,
			user_input: input.userInput,
			narrative_text: input.narrativeText,
			raw_text: input.rawText ?? null,
		};
	}

	// ------------------------------------------------------------------
	// 指令（创造模式，§10.1）
	// ------------------------------------------------------------------

	/** 新建剧情大纲指令。status 封闭枚举（active/done/revoked）。 */
	insertDirective(input: { turnSeq: number; content: string; status?: "active" | "done" | "revoked" }): DirectiveRow {
		assertTurnSeq(input.turnSeq);
		const res = this.db
			.prepare("INSERT INTO directives (turn_seq, content, status) VALUES (?, ?, ?)")
			.run(input.turnSeq, input.content, input.status ?? "active");
		return {
			id: Number(res.lastInsertRowid),
			turn_seq: input.turnSeq,
			content: input.content,
			status: input.status ?? "active",
		};
	}

	/** 更新指令状态。 */
	updateDirectiveStatus(directiveId: number, status: "active" | "done" | "revoked"): void {
		this.db.prepare("UPDATE directives SET status = ? WHERE id = ?").run(status, directiveId);
	}
}
