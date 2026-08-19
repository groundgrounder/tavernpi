// db 工具集（pi ToolDefinition，typebox 参数 schema）。
// 查询：get_clock / query_events / get_npc；写入：write_event / advance_clock。
//
// turn_seq 暴露取舍：写入工具**不向模型暴露 turn_seq**——由 createDbTools 注入的
// getCurrentTurnSeq() 提供（M2 起由 turn pipeline 编排器注入当前轮）。
// 未注入时写入工具执行即抛错（fail-loud），避免静默落错轮次；查询工具不受影响。
// M2 data subagent 才是主要写者；本阶段工具集是纪律链路的最小验证面。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { NpcComposite } from "./reader.ts";
import type { StoryDb } from "./story-db.ts";

export interface DbToolsOptions {
	/** 当前轮次提供器。必注入（M2 起由编排器提供）；缺省时写入工具执行抛错。 */
	getCurrentTurnSeq?: () => number;
}

const EMPTY_PARAMS = Type.Object({}, { additionalProperties: false });

/** 写入工具的 turn_seq 获取：未注入 provider 时 fail-loud（防静默落 turn 1）。 */
function requireTurnSeq(getCurrentTurnSeq: (() => number) | undefined): number {
	if (getCurrentTurnSeq === undefined) {
		throw new Error(
			"当前轮次未注入：createDbTools 需提供 getCurrentTurnSeq（M2 起由 turn pipeline 编排器注入）",
		);
	}
	return getCurrentTurnSeq();
}

/** 为指定 storyDb 创建 db 工具集。 */
export function createDbTools(storyDb: StoryDb, options: DbToolsOptions = {}): ToolDefinition[] {
	const getTurnSeq = options.getCurrentTurnSeq;

	const getClockTool = defineTool({
		name: "get_clock",
		label: "读取故事时钟",
		description: "返回当前故事时间、历法与粒度（clock 单例）。",
		parameters: EMPTY_PARAMS,
		execute: async () => {
			const clock = storyDb.reader.getClock();
			const text = clock
				? `当前故事时间: ${clock.current_time}（历法 ${clock.calendar}，粒度 ${clock.granularity}）`
				: "(时钟未初始化)";
			return { content: [{ type: "text", text }], details: { clock: clock ?? null } };
		},
	});

	const queryEventsTool = defineTool({
		name: "query_events",
		label: "查询事件",
		description: "按轮次范围与事件类型查询 events 表（按 id 升序）。",
		parameters: Type.Object(
			{
				from_turn: Type.Optional(Type.Integer({ description: "起始 turn_seq（含）" })),
				to_turn: Type.Optional(Type.Integer({ description: "结束 turn_seq（含）" })),
				type: Type.Optional(Type.String({ description: "事件类型过滤" })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const rows = storyDb.reader.listEvents({
				fromTurn: params.from_turn,
				toTurn: params.to_turn,
				type: params.type,
			});
			const text =
				rows.length === 0
					? "(无事件)"
					: rows.map((e) => `#${e.id} turn${e.turn_seq} ${e.summary}`).join("\n");
			return { content: [{ type: "text", text }], details: { events: rows } };
		},
	});

	const getNpcTool = defineTool({
		name: "get_npc",
		label: "读取 NPC",
		description: "返回指定 NPC 的基本信息、性格特征、记忆与关系。",
		parameters: Type.Object(
			{ npc_id: Type.Integer({ description: "NPC 的 id" }) },
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const { npc, traits, memories, relations } = storyDb.reader.getNpc(params.npc_id);
			const empty: NpcComposite = { npc: undefined, traits: [], memories: [], relations: [] };
			if (!npc) {
				return {
					content: [{ type: "text", text: `NPC #${params.npc_id} 不存在` }],
					details: empty,
				};
			}
			const traitsText = traits.map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
			const memoriesText = memories.map((m) => `${m.kind}: ${m.content}`).join("；") || "(无)";
			const relationsText = relations
				.map((r) => `${r.npc_a}↔${r.npc_b}=${r.disposition}`)
				.join(", ") || "(无)";
			const text =
				`NPC #${npc.id} ${npc.name}（status: ${npc.status}）\n` +
				`特征: ${traitsText}\n记忆: ${memoriesText}\n关系: ${relationsText}`;
			return { content: [{ type: "text", text }], details: { npc, traits, memories, relations } };
		},
	});

	const writeEventTool = defineTool({
		name: "write_event",
		label: "写入事件",
		description:
			"把一条叙事事件写入 events 表。turn_seq 由引擎从当前轮次取得，模型不需要也不应该提供。",
		parameters: Type.Object(
			{
				summary: Type.String({ description: "事件的一句话摘要" }),
				detail: Type.Optional(Type.String({ description: "事件的细节描述" })),
				story_time: Type.Optional(Type.String({ description: "事件发生的故事时间" })),
				type: Type.Optional(Type.String({ description: "事件类型" })),
				participants: Type.Optional(Type.String({ description: "参与者" })),
				location: Type.Optional(Type.String({ description: "地点" })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			// 走强制写入 API（DbWriter.insertEvent，turnSeq 必填）—— 纪律链路的验证点。
			const row = storyDb.writer.insertEvent({
				turnSeq: requireTurnSeq(getTurnSeq),
				summary: params.summary,
				detail: params.detail,
				storyTime: params.story_time,
				type: params.type,
				participants: params.participants,
				location: params.location,
			});
			return {
				content: [{ type: "text", text: `已记录事件 #${row.id}（turn_seq=${row.turn_seq}）: ${row.summary}` }],
				details: row,
			};
		},
	});

	const advanceClockTool = defineTool({
		name: "advance_clock",
		label: "推进故事时钟",
		description: "推进故事时间：写 time_log（from→to）并更新 clock 单例。",
		parameters: Type.Object(
			{
				to_time: Type.String({ description: "推进后的故事时间" }),
				span_note: Type.Optional(Type.String({ description: "时间跨度说明" })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			// 走强制写入 API（DbWriter.advanceClock）：from_time 由 writer 内部读 clock 单例，
			// 保证 time_log.from_time ≡ 写入时 clock.current_time。
			const row = storyDb.writer.advanceClock({
				turnSeq: requireTurnSeq(getTurnSeq),
				toTime: params.to_time,
				spanNote: params.span_note,
			});
			return {
				content: [
					{
						type: "text",
						text: `时钟已推进: ${row.from_time} → ${row.to_time}（轮次 ${row.turn_seq}）`,
					},
				],
				details: row,
			};
		},
	});

	return [getClockTool, queryEventsTool, getNpcTool, writeEventTool, advanceClockTool];
}
