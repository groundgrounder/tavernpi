// DB 摘要渲染（§5.2 读取渲染由 harness 负责）：把故事 DB 的权威事实渲染成紧凑确定性文本，
// 供 before_agent_start 注入主叙事系统提示（{{db_summary}}）与 data subagent 的 userPrompt。
//
// 内容：当前故事时间、玩家位置路径、地点树、NPC 表（特征前 5 + salience 最高 3 条记忆）、
// 近期事件 N 条、world_state（排除 player_location 保留键）、active phase。
// renderLocationTree/renderLocationPath 复制自 db/tools.ts（模块私有，不导出；为保持 tools.ts
// 不动而在本模块内复制，注释与来源一致）。

import type { StoryDb } from "../db/story-db.ts";
import type { LocationRow } from "../db/types.ts";
import { PLAYER_LOCATION_KEY } from "../db/types.ts";

/** 渲染 locations 为缩进树（按 parent_id 递归；root = parent_id 为 null 的条目）。复制自 db/tools.ts。 */
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

/** 渲染地点名路径（如 王城 > 庭院）+ 地点 id。复制自 db/tools.ts。 */
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

/** 渲染故事 DB 权威摘要（§5.2）。recentEvents 控制近期事件条数（默认 10）。 */
export function renderDbSummary(storyDb: StoryDb, opts: { recentEvents?: number } = {}): string {
	const reader = storyDb.reader;
	const recentEvents = opts.recentEvents ?? 10;
	const lines: string[] = [];

	const clock = reader.getClock();
	lines.push(
		`当前故事时间: ${clock ? `${clock.current_time}（历法 ${clock.calendar}，粒度 ${clock.granularity}）` : "(未初始化)"}`,
	);

	const locations = reader.listLocations();
	const player = reader.getPlayerLocation();
	lines.push(`玩家位置: ${player ? renderLocationPath(player, locations) : "(玩家尚未定位)"}`);

	if (locations.length > 0) {
		lines.push("地点树:");
		lines.push(...renderLocationTree(locations));
	}

	const npcs = reader.listNpcs();
	if (npcs.length > 0) {
		lines.push("NPC:");
		for (const npc of npcs) {
			const composite = reader.getNpc(npc.id);
			const traitsText = composite.traits.slice(0, 5).map((t) => `${t.trait}=${t.weight}`).join(", ") || "(无)";
			const memoriesText =
				composite.memories
					.slice(0, 3)
					.map((m) => m.content)
					.join("；") || "(无)";
			const locText = npc.current_location_name !== null ? `位置 ${npc.current_location_name}` : "位置 (未定位)";
			lines.push(`#${npc.id} ${npc.name}（status: ${npc.status}，${locText}）`);
			lines.push(`  特征[${traitsText}]`);
			lines.push(`  记忆[${memoriesText}]`);
		}
	}

	const events = reader.listEvents();
	if (events.length > 0) {
		lines.push(`近期事件（最近 ${recentEvents} 条）:`);
		for (const e of events.slice(-recentEvents)) {
			lines.push(`- turn${e.turn_seq} ${e.summary}`);
		}
	}

	// 排除内核保留键 player_location：玩家位置已单独呈现，重复呈现会让模型误以为
	// 可写 world_state.player_location（实际只能经 location_moves，见 changeset 校验）。
	const worldState = reader.listWorldState().filter((w) => w.key !== PLAYER_LOCATION_KEY);
	if (worldState.length > 0) {
		lines.push("世界状态:");
		for (const w of worldState) {
			lines.push(`- ${w.key} = ${w.value}`);
		}
	}

	const activePhases = reader.listPhases().filter((p) => p.ended_turn === null);
	if (activePhases.length > 0) {
		lines.push("当前阶段:");
		for (const p of activePhases) {
			lines.push(`- ${p.name}${p.goals ? `：${p.goals}` : ""}`);
		}
	}

	return lines.join("\n");
}
