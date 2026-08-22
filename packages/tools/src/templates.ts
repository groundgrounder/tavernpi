// 卡作者 SQL 表模板库（创作规划 §5.2「常用表模板可直接抄改」）。
// 模板 SQL 文件在 packages/tools/templates/ 下；本模块负责元数据与读取。
//
// 模板纪律（§5.2 / §4.0）：
// - 模板 SQL 必须自带「<包名>_」前缀占位说明（表名用 PACKNAME 占位，注释注明替换规则）；
// - 每个字段带中文注释，注释即 data subagent 的填写说明（§5.2「表/列的注释就是填写说明」）。
//
// 用法（CLI）：
//   tavernpi-pack templates              列出全部模板
//   tavernpi-pack templates char-status  打印某模板完整 SQL（复制进 db/schema.sql）

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PackTemplate {
	/** 模板 id（templates 命令的 <id> 参数）。 */
	id: string;
	/** 中文名。 */
	title: string;
	/** 一句话用途说明。 */
	description: string;
	/** 模板 SQL 文件名（templates/ 目录下）。 */
	file: string;
}

const TEMPLATE_META: readonly PackTemplate[] = [
	{
		id: "char-status",
		title: "角色状态栏",
		description: "每个 NPC 一行：好感度（favor -100~100）、生命、体力等面板化状态。",
		file: "char-status.sql",
	},
	{
		id: "inventory",
		title: "物品栏",
		description: "持有者（玩家或 NPC）↔ 物品清单：数量、分类、装备状态。",
		file: "inventory.sql",
	},
	{
		id: "quest-progress",
		title: "任务进度",
		description: "每个任务一行：阶段序号、状态、进度摘要，随剧情推进更新。",
		file: "quest-progress.sql",
	},
];

/** templates/ 目录（相对本模块：src/../templates）。 */
export function templateDir(): string {
	return join(import.meta.dirname, "../templates");
}

/** 全部模板元数据（不含 SQL 正文）。 */
export function listTemplates(): readonly PackTemplate[] {
	return TEMPLATE_META;
}

/** 按 id 取模板（未知 id 返回 null）。 */
export function findTemplate(id: string): PackTemplate | null {
	return TEMPLATE_META.find((t) => t.id === id) ?? null;
}

/** 读取模板完整 SQL 文本（含注释头）。 */
export function readTemplateSql(template: PackTemplate): string {
	return readFileSync(join(templateDir(), template.file), "utf8");
}
