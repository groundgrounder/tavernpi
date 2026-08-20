// 提示词分层加载器（创作规划 §6.5）。
// 四层覆盖：内置 < 全局 < 卡包 < 故事级；高层覆盖低层，出错/为空回退到下一层。
//
// 层级目录（各层可选，未提供的层整体跳过，内置层必存在）：
//   builtin  packages/core/prompts/<role>.md        —— 模块自带（narrator.md 等）
//   global   ~/.tavernpi/prompts/<role>.md          —— 玩家偏好
//   pack     <packDir>/prompts/<role>.md            —— 卡作者文风/填表语义
//   story    <storyDir>/prompts/<role>.md           —— 故事内调整
//
// 回退规则：高层文件读取失败（非 ENOENT）或内容为空 → 记 warning 并回退到下一层；
// 文件不存在（ENOENT）→ 静默回退（未提供覆盖属正常，不产生 warning）。
// 占位符语法（M2 定案）：`{{标识符}}`，标识符 = [A-Za-z][A-Za-z0-9_]*，两侧允许空白。
// 未在 values 中提供的占位符原样保留并记入 unknownPlaceholders（去重，保首现顺序）。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type PromptLayer = "builtin" | "global" | "pack" | "story";

export interface PromptLayerDirs {
	/** 全局层目录（缺省 ~/.tavernpi/prompts）。未提供则跳过该层。 */
	globalDir?: string;
	/** 卡包根目录（提示词位于 <packDir>/prompts/）。未提供则跳过该层。 */
	packDir?: string;
	/** 故事根目录（提示词位于 <storyDir>/prompts/）。未提供则跳过该层。 */
	storyDir?: string;
}

export interface LoadedPrompt {
	role: string;
	content: string;
	layer: PromptLayer;
	path: string;
	/** 回退链上遇到的空文件/读取失败说明（命中层以上的故障；文件缺失不在此列）。 */
	warnings: string[];
}

/** 内置提示词目录：本文件位于 src/prompts/，内置层即仓库级 packages/core/prompts/。 */
export function builtinPromptsDir(): string {
	return resolve(import.meta.dirname, "../../prompts");
}

/** 默认全局提示词目录 ~/.tavernpi/prompts。 */
export function defaultGlobalPromptsDir(): string {
	return join(homedir(), ".tavernpi", "prompts");
}

const ROLE_RE = /^[a-z][a-z0-9_]*$/;
const PROMPT_EXT = ".md";

/** role 白名单校验（防路径穿越：只允许小写字母开头的标识符）。 */
function assertValidRole(role: string): void {
	if (!ROLE_RE.test(role)) {
		throw new Error(`非法提示词角色名: ${JSON.stringify(role)}（仅允许 [a-z][a-z0-9_]*）`);
	}
}

type LayerProbe =
	| { status: "ok"; path: string; content: string }
	| { status: "missing"; path: string }
	| { status: "empty"; path: string }
	| { status: "error"; path: string; message: string };

/** 探测单层：读 <dir>/<role>.md。ENOENT=未提供覆盖；空/其他错误分别标记。 */
function probeLayer(dir: string, role: string): LayerProbe {
	const path = join(dir, `${role}${PROMPT_EXT}`);
	try {
		const content = readFileSync(path, "utf-8");
		if (content.trim() === "") {
			return { status: "empty", path };
		}
		return { status: "ok", path, content };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "missing", path };
		}
		return { status: "error", path, message: (err as Error).message };
	}
}

/**
 * 按 story > pack > global > builtin 顺序加载提示词：首个非空可读层生效。
 * 未命中任何层（内置层缺失）→ 抛错。
 */
export function loadPrompt(role: string, dirs: PromptLayerDirs = {}): LoadedPrompt {
	assertValidRole(role);
	const warnings: string[] = [];
	// 层目录语义：builtin/global 目录即提示词目录；pack/story 是包/故事根目录，
	// 提示词位于 <root>/prompts/ 子目录（§4.1 卡包布局 / 故事目录布局）。
	const layers: Array<{ layer: PromptLayer; dir: string | undefined }> = [
		{ layer: "story", dir: dirs.storyDir !== undefined ? join(dirs.storyDir, "prompts") : undefined },
		{ layer: "pack", dir: dirs.packDir !== undefined ? join(dirs.packDir, "prompts") : undefined },
		{ layer: "global", dir: dirs.globalDir },
		{ layer: "builtin", dir: builtinPromptsDir() },
	];
	for (const { layer, dir } of layers) {
		if (dir === undefined || dir.length === 0) continue; // 未提供该层：静默落到下一层
		const probe = probeLayer(dir, role);
		if (probe.status === "ok") {
			return { role, content: probe.content, layer, path: probe.path, warnings };
		}
		if (probe.status === "empty") {
			warnings.push(`${layer} 层提示词为空，回退到下一层: ${probe.path}`);
		} else if (probe.status === "error") {
			warnings.push(`${layer} 层提示词读取失败，回退到下一层: ${probe.path}: ${probe.message}`);
		}
		// missing：静默继续（未提供覆盖属正常）
	}
	throw new Error(`提示词 ${JSON.stringify(role)} 未命中任何层（内置层缺失）`);
}

export interface PlaceholderRender {
	text: string;
	/** 模板中存在但 values 未提供的占位符名（去重，保首现顺序）。 */
	unknownPlaceholders: string[];
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** 占位符注入：values 里有的替换（回调返回的字面量不解释 $ 序列）；没有的原样保留并去重记名。 */
export function renderPlaceholders(template: string, values: Record<string, string>): PlaceholderRender {
	const unknownPlaceholders: string[] = [];
	const text = template.replace(PLACEHOLDER_RE, (match, name: string) => {
		const value = values[name];
		if (value !== undefined) {
			return value;
		}
		if (!unknownPlaceholders.includes(name)) {
			unknownPlaceholders.push(name);
		}
		return match; // 原样保留（含原始空白）
	});
	return { text, unknownPlaceholders };
}
