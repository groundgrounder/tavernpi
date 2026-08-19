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
import type { LocationRow } from "./types.ts";

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

/** 渲染 locations 为缩进树（按 parent_id 递归；root = parent_id 为 null 的条目）。 */
function renderLocationTree(locations: LocationRow[]): string[] {
	const children = new Map<number | null, LocationRow[]>();
	for (const loc of locations) {
		const list = children.get(loc.parent_id) ?? [];
		list.push(loc);
		children.set(loc.parent_id, list);
	}
	const lines: string[] = [];
	const walk = (parent: number | null, depth: number): void => {
		for (const loc of children.get(parent) ?? []) {
			lines.push(`${"  ".repeat(depth)}#${loc.id} ${loc.name}`);
			walk(loc.id, depth + 1);
		}
	};
	walk(null, 0);
	return lines;
}

/** 渲染地点名路径（如 王城 > 庭院）+ 地点 id。 */
function renderLocationPath(location: LocationRow, locations: LocationRow[]): string {
	const byId = new Map<number, LocationRow>();
	for (const loc of locations) byId.set(loc.id, loc);
	const names: string[] = [location.name];
	let cur: LocationRow = location;
	while (cur.parent_id !== null) {
		const parent = byId.get(cur.parent_id);
		if (!parent) break;
		names.unshift(parent.name);
		cur = parent;
	}
	return `${names.join(" > ")}（地点 #${location.id}）`;
}

/** 为指定 storyDb 创建 db 工具集。
 * storyDb 可为实例或 getter（恢复会替换 StoryDb 实例，getter 保证工具始终访问当前库）。 */
export function createDbTools(storyDb: StoryDb | (() => StoryDb), options: DbToolsOptions = {}): ToolDefinition[] {
	const getStoryDb = typeof storyDb === "function" ? storyDb : () => storyDb;
	const getTurnSeq = options.getCurrentTurnSeq;

	const getClockTool = defineTool({
		name: "get_clock",
		label: "读取故事时钟",
		description: "返回当前故事时间、历法与粒度（clock 单例）。",
		parameters: EMPTY_PARAMS,
		execute: async () => {
			const clock = getStoryDb().reader.getClock();
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
			const rows = getStoryDb().reader.listEvents({
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
			const { npc, traits, memories, relations } = getStoryDb().reader.getNpc(params.npc_id);
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
			const locationText = npc.current_location !== null ? `#${npc.current_location} ${npc.current_location_name ?? "?"}` : "(未定位)";
			const text =
				`NPC #${npc.id} ${npc.name}（status: ${npc.status}，位置: ${locationText}）\n` +
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
			const row = getStoryDb().writer.insertEvent({
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
			const row = getStoryDb().writer.advanceClock({
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

	const getLocationTool = defineTool({
		name: "get_location",
		label: "读取地点与玩家位置",
		description:
			"返回玩家当前所在地（含父地点链，如 王城 > 庭院）与 locations 注册表的地点树摘要（含各地点 id）。调用 move_to 之前必须先经本工具查询 location_id，不得编造或猜测地点 id。",
		parameters: EMPTY_PARAMS,
		execute: async () => {
			const storyDb = getStoryDb();
			const locations = storyDb.reader.listLocations();
			const player = storyDb.reader.getPlayerLocation();
			const playerText = player ? renderLocationPath(player, locations) : "(玩家尚未定位)";
			const treeLines = renderLocationTree(locations);
			const text = `当前玩家位置: ${playerText}\n地点注册表:\n${treeLines.length === 0 ? "(空)" : treeLines.join("\n")}`;
			return { content: [{ type: "text", text }], details: { player: player ?? null, locations } };
		},
	});

	const moveToTool = defineTool({
		name: "move_to",
		label: "移动玩家",
		description:
			"把玩家移动到指定地点。location_id 必须先经 get_location 查询取得，不得编造；未登记的地点会被拒绝。移动会写入 location_log（from→to）并更新玩家位置。",
		parameters: Type.Object(
			{
				location_id: Type.Integer({ description: "目标地点 id（必须先经 get_location 查询，不得编造）" }),
				note: Type.Optional(Type.String({ description: "移动说明（可空）" })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			// 走强制写入 API（DbWriter.moveSubject，subject='player'）—— 登记校验与 location_log 由 DB 层保证。
			const storyDb = getStoryDb();
			const row = storyDb.writer.moveSubject({
				turnSeq: requireTurnSeq(getTurnSeq),
				subject: "player",
				toLocationId: params.location_id,
				note: params.note,
			});
			const fromText = row.from_location === null ? "(未定位)" : `#${row.from_location} ${row.from_location_name ?? ""}`;
			const toText = `#${row.to_location} ${row.to_location_name ?? ""}`;
			return {
				content: [{ type: "text", text: `玩家已移动: ${fromText} → ${toText}（轮次 ${row.turn_seq}）` }],
				details: row,
			};
		},
	});

	return [getClockTool, queryEventsTool, getNpcTool, writeEventTool, advanceClockTool, getLocationTool, moveToTool];
}
