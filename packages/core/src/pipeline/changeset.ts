// data subagent 变更集（创作规划 §6.1 data 是唯一写者的输出形态）。
// schema 用 zod v4 定义（字段命名 snake_case 与 DB 对齐），经 z.toJSONSchema() 转为
// JSON Schema 接入 P1 runSubagent 输出工具的 constrainedSampling。
//
// schema 保持朴素：只含 object/string/number/int/array/enum/optional，不用 union/ref/recursion
// （strict constrained sampling 兼容性——注意：optional 字段经 toJSONSchema 会生成
// anyOf+null 变体，属已知兼容风险，见 M2-P2 报告遗留风险节）。
//
// applyChangeset 先全量语义校验（收集全部问题，不抛），非空则抛错且**零写入**（原子性）；
// 通过后 writer.transaction() 内按序应用（new_locations → new_npcs → events → npc_updates →
// location_moves → world_state → phase_start/end → time_advance 最后）。

import type { TSchema } from "typebox";
import { z } from "zod";
import type { StoryDb } from "../db/story-db.ts";
import { PLAYER_LOCATION_KEY } from "../db/types.ts";

const eventSchema = z.object({
	summary: z.string().min(1),
	detail: z.string().optional(),
	type: z.string().optional(),
	participants: z.string().optional(),
	location_name: z.string().optional(),
	story_time: z.string().optional(),
});

const newLocationSchema = z.object({
	name: z.string().min(1),
	parent_name: z.string().optional(),
	detail: z.string().optional(),
});

const locationMoveSchema = z.object({
	subject: z.string().min(1), // 'player' 或 'npc:<id>'（格式语义校验见 validateChangesetSemantics）
	to_location_name: z.string().min(1),
	note: z.string().optional(),
});

const newNpcSchema = z.object({
	name: z.string().min(1),
	card_ref: z.string().optional(),
	status: z.string().optional(),
	location_name: z.string().optional(),
});

const npcUpdateSchema = z.object({
	npc_id: z.number().int().positive(),
	status: z.string().optional(),
	memories: z
		.array(
			z.object({
				kind: z.string().min(1),
				content: z.string().min(1),
				salience: z.number().optional(),
			}),
		)
		.optional(),
	traits: z
		.array(
			z.object({
				trait: z.string().min(1),
				weight: z.number(),
				source: z.string().optional(),
			}),
		)
		.optional(),
	relations: z
		.array(
			z.object({
				other_npc_id: z.number().int().positive(),
				disposition: z.number().int(),
			}),
		)
		.optional(),
});

const worldStateEntrySchema = z.object({
	key: z.string().min(1),
	value: z.string().min(1),
});

/** data subagent 输出形态的 zod schema（§6.1 变更集）。 */
export const changesetZodSchema = z.object({
	events: z.array(eventSchema).default([]),
	time_advance: z
		.object({
			to_time: z.string().min(1),
			span_note: z.string().optional(),
		})
		.optional(),
	new_locations: z.array(newLocationSchema).default([]),
	location_moves: z.array(locationMoveSchema).default([]),
	new_npcs: z.array(newNpcSchema).default([]),
	npc_updates: z.array(npcUpdateSchema).default([]),
	world_state: z.array(worldStateEntrySchema).default([]),
	phase_start: z
		.object({
			name: z.string().min(1),
			goals: z.string().optional(),
		})
		.optional(),
	phase_end: z
		.object({
			name: z.string().min(1),
		})
		.optional(),
});

export type Changeset = z.infer<typeof changesetZodSchema>;

/** JSON Schema 产物（接入 subagent 输出工具的 parameters；strict constrained sampling 用）。 */
export const CHANGELOG_JSON_SCHEMA = changesetZodSchema.toJSONSchema() as unknown as TSchema;

type SubjectRef = { kind: "player" } | { kind: "npc"; npcId: number } | "invalid";

/** 解析 location_moves.subject（'player' | 'npc:<id>'）；格式非法返回 'invalid'。 */
function parseSubjectName(subject: string): SubjectRef {
	if (subject === "player") return { kind: "player" };
	const m = /^npc:(\d+)$/.exec(subject);
	if (m) return { kind: "npc", npcId: Number(m[1]) };
	return "invalid";
}

/**
 * 语义校验：收集全部问题（不抛）。覆盖：
 * - 地点名可解析性：注册表 ∪ 本变更集 new_locations 构成可解析集；events.location_name /
 *   location_moves.to_location_name / new_npcs.location_name / new_locations.parent_name 必须可解析；
 * - NPC 存在性：npc_updates.npc_id / relations.other_npc_id / location_moves subject='npc:<id>'；
 * - time_advance 不倒流（字符串字典序比较——ISO 日期前提，同日时段推进走 span_note，相等允许）；
 * - world_state 禁写内核保留键 player_location（玩家位置只能经 location_moves）；
 * - phase_end.name 必须匹配一个 ended_turn IS NULL 的 phase。
 */
export function validateChangesetSemantics(storyDb: StoryDb, cs: Changeset): string[] {
	const problems: string[] = [];

	const registeredLocations = new Set(storyDb.reader.listLocations().map((l) => l.name));
	const resolvableLocations = new Set([...registeredLocations, ...cs.new_locations.map((l) => l.name)]);
	const hasLocation = (name: string): boolean => resolvableLocations.has(name);

	const registeredNpcs = new Set(storyDb.reader.listNpcs().map((n) => n.id));

	for (const ev of cs.events) {
		if (ev.location_name !== undefined && !hasLocation(ev.location_name)) {
			problems.push(
				`events.location_name 未登记且未在本变更集 new_locations 中: ${JSON.stringify(ev.location_name)}`,
			);
		}
	}
	for (const move of cs.location_moves) {
		if (!hasLocation(move.to_location_name)) {
			problems.push(
				`location_moves.to_location_name 未登记且未在本变更集 new_locations 中: ${JSON.stringify(move.to_location_name)}`,
			);
		}
		const parsed = parseSubjectName(move.subject);
		if (parsed === "invalid") {
			problems.push(`location_moves.subject 格式非法: ${JSON.stringify(move.subject)}（应为 'player' 或 'npc:<id>'）`);
		} else if (parsed.kind === "npc" && !registeredNpcs.has(parsed.npcId)) {
			problems.push(`location_moves.subject 引用不存在的 NPC #${parsed.npcId}`);
		}
	}
	for (const npc of cs.new_npcs) {
		if (npc.location_name !== undefined && !hasLocation(npc.location_name)) {
			problems.push(
				`new_npcs.location_name 未登记且未在本变更集 new_locations 中: ${JSON.stringify(npc.location_name)}`,
			);
		}
	}
	for (const loc of cs.new_locations) {
		if (loc.parent_name !== undefined && !hasLocation(loc.parent_name)) {
			problems.push(
				`new_locations.parent_name 未登记且未在本变更集 new_locations 中: ${JSON.stringify(loc.parent_name)}`,
			);
		}
	}
	for (const update of cs.npc_updates) {
		if (!registeredNpcs.has(update.npc_id)) {
			problems.push(`npc_updates.npc_id 不存在: #${update.npc_id}`);
		}
		for (const rel of update.relations ?? []) {
			if (!registeredNpcs.has(rel.other_npc_id)) {
				problems.push(`npc_updates.relations.other_npc_id 不存在: #${rel.other_npc_id}`);
			}
		}
	}
	if (cs.time_advance !== undefined) {
		const clock = storyDb.reader.getClock();
		if (clock !== undefined && cs.time_advance.to_time < clock.current_time) {
			problems.push(
				`time_advance.to_time 早于当前故事时间: ${JSON.stringify(cs.time_advance.to_time)} < ${JSON.stringify(clock.current_time)}（字符串字典序；ISO 日期前提）`,
			);
		}
	}
	for (const w of cs.world_state) {
		if (w.key === PLAYER_LOCATION_KEY) {
			problems.push(`world_state.key 是内核保留键，玩家位置只能经 location_moves 更新: ${JSON.stringify(w.key)}`);
		}
	}
	if (cs.phase_end !== undefined) {
		const active = storyDb.reader.listPhases().filter((p) => p.ended_turn === null);
		if (!active.some((p) => p.name === cs.phase_end!.name)) {
			problems.push(`phase_end.name 不匹配任何未结束的 phase: ${JSON.stringify(cs.phase_end.name)}`);
		}
	}
	return problems;
}

export interface ApplySummary {
	events: number;
	newLocations: number;
	newNpcs: number;
	npcUpdates: number;
	locationMoves: number;
	worldState: number;
	timeAdvanced: boolean;
	phaseStarted: number;
	phaseEnded: number;
}

/**
 * 应用变更集：先全量语义校验（非空则抛错、零写入），再在单事务内按序应用。
 * new_locations 先登记（幂等，按 name 去重）——本变更集内后文引用（事件/移动/NPC 落位）可解析。
 * time_advance 最后：advanceClock 的 from_time 由 writer 内部取当前 clock，来源一致由 DB 层保证。
 */
export function applyChangeset(
	storyDb: StoryDb,
	cs: Changeset,
	ctx: { turnSeq: number; createdEntryId?: string },
): ApplySummary {
	const problems = validateChangesetSemantics(storyDb, cs);
	if (problems.length > 0) {
		throw new Error(`变更集校验失败（${problems.length} 个问题）:\n${problems.map((p) => `- ${p}`).join("\n")}`);
	}

	const writer = storyDb.writer;
	const summary: ApplySummary = {
		events: 0,
		newLocations: 0,
		newNpcs: 0,
		npcUpdates: 0,
		locationMoves: 0,
		worldState: 0,
		timeAdvanced: false,
		phaseStarted: 0,
		phaseEnded: 0,
	};

	writer.transaction(() => {
		// 地点名 → id 解析表（先载入注册表，新登记的再补充）
		const locationIdByName = new Map(storyDb.reader.listLocations().map((l) => [l.name, l.id]));
		for (const loc of cs.new_locations) {
			const parentId = loc.parent_name !== undefined ? locationIdByName.get(loc.parent_name) : undefined;
			const row = writer.insertLocation({ name: loc.name, parentId, detail: loc.detail });
			if (!locationIdByName.has(row.name)) {
				locationIdByName.set(row.name, row.id);
				summary.newLocations++;
			}
		}

		// 新 NPC：插入后若有 location_name 则 moveSubject 落位（location_moves 计数并入）
		for (const npc of cs.new_npcs) {
			const row = writer.insertNpc({ name: npc.name, cardRef: npc.card_ref, status: npc.status });
			summary.newNpcs++;
			if (npc.location_name !== undefined) {
				const locId = locationIdByName.get(npc.location_name);
				if (locId !== undefined) {
					writer.moveSubject({ turnSeq: ctx.turnSeq, subject: `npc:${row.id}`, toLocationId: locId });
					summary.locationMoves++;
				}
			}
		}

		for (const ev of cs.events) {
			const locationId = ev.location_name !== undefined ? locationIdByName.get(ev.location_name) : undefined;
			writer.insertEvent({
				turnSeq: ctx.turnSeq,
				summary: ev.summary,
				detail: ev.detail,
				type: ev.type,
				participants: ev.participants,
				location: ev.location_name,
				locationId,
				storyTime: ev.story_time,
				createdEntryId: ctx.createdEntryId,
			});
			summary.events++;
		}

		for (const update of cs.npc_updates) {
			if (update.status !== undefined) {
				writer.updateNpcStatus(update.npc_id, update.status);
			}
			for (const mem of update.memories ?? []) {
				writer.insertNpcMemory({
					npcId: update.npc_id,
					turnSeq: ctx.turnSeq,
					kind: mem.kind,
					content: mem.content,
					salience: mem.salience,
				});
			}
			for (const trait of update.traits ?? []) {
				writer.insertNpcTrait({
					npcId: update.npc_id,
					trait: trait.trait,
					weight: trait.weight,
					source: trait.source,
					turnSeq: ctx.turnSeq,
				});
			}
			for (const rel of update.relations ?? []) {
				writer.insertNpcRelation({
					npcA: update.npc_id,
					npcB: rel.other_npc_id,
					disposition: rel.disposition,
					turnSeq: ctx.turnSeq,
				});
			}
			summary.npcUpdates++;
		}

		for (const move of cs.location_moves) {
			const locId = locationIdByName.get(move.to_location_name);
			if (locId !== undefined) {
				// 校验已保证可解析；undefined 兜底防御（类型层面不可达）
				writer.moveSubject({ turnSeq: ctx.turnSeq, subject: move.subject, toLocationId: locId, note: move.note });
				summary.locationMoves++;
			}
		}

		for (const w of cs.world_state) {
			writer.upsertWorldState({ key: w.key, value: w.value, turnSeq: ctx.turnSeq });
			summary.worldState++;
		}

		if (cs.phase_start !== undefined) {
			writer.insertPhase({ name: cs.phase_start.name, startedTurn: ctx.turnSeq, goals: cs.phase_start.goals });
			summary.phaseStarted++;
		}
		if (cs.phase_end !== undefined) {
			const phase = storyDb.reader.listPhases().find((p) => p.name === cs.phase_end!.name && p.ended_turn === null);
			if (phase) {
				writer.endPhase(phase.id, ctx.turnSeq);
				summary.phaseEnded++;
			}
		}

		if (cs.time_advance !== undefined) {
			writer.advanceClock({ turnSeq: ctx.turnSeq, toTime: cs.time_advance.to_time, spanNote: cs.time_advance.span_note });
			summary.timeAdvanced = true;
		}
	});

	return summary;
}
