// 模型配置最小形态（创作规划 §6.6：~/.tavernpi/settings.json 里 models.narrator/story/npc/data/stylize
// 各自指定 provider/model id）。M2 只承载字段解析；provider/id 是否真实存在不在此校验
// （解析在调用侧经 ModelRuntime.getModel 完成）。
//
// 容错纪律：文件不存在 → 空配置无 warning；JSON 解析失败 → warning + 空配置；
// models 下字段形态非法（非 {provider:string,id:string}，空字符串视同非法）→ warning + 忽略该字段。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface TavernModels {
	narrator?: ModelRef;
	data?: ModelRef;
	story?: ModelRef;
	npc?: ModelRef;
	stylize?: ModelRef;
}

export interface TavernSettings {
	models: TavernModels;
}

/** 默认设置文件路径 ~/.tavernpi/settings.json。 */
export function defaultSettingsPath(): string {
	return join(homedir(), ".tavernpi", "settings.json");
}

const MODEL_ROLES = ["narrator", "data", "story", "npc", "stylize"] as const;
type ModelRole = (typeof MODEL_ROLES)[number];

function isModelRef(value: unknown): value is ModelRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const ref = value as Record<string, unknown>;
	return (
		typeof ref["provider"] === "string" &&
		ref["provider"].length > 0 &&
		typeof ref["id"] === "string" &&
		ref["id"].length > 0
	);
}

/**
 * 读取模型设置。缺文件返回空配置无 warning；解析/形态错误 → warning + 空配置（fail-open，
 * 配置缺失时 subagent 走 pi 默认模型解析，见 runtime.ts）。
 */
export function loadSettings(path: string = defaultSettingsPath()): { settings: TavernSettings; warnings: string[] } {
	const warnings: string[] = [];
	const models: TavernModels = {};

	if (!existsSync(path)) {
		return { settings: { models }, warnings };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		warnings.push(`settings.json 解析失败，使用空配置: ${path}: ${(err as Error).message}`);
		return { settings: { models }, warnings };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push(`settings.json 根节点不是对象，使用空配置: ${path}`);
		return { settings: { models }, warnings };
	}

	const modelsValue = (parsed as Record<string, unknown>)["models"];
	if (modelsValue !== undefined) {
		if (typeof modelsValue !== "object" || modelsValue === null || Array.isArray(modelsValue)) {
			warnings.push(`settings.json 的 models 不是对象，已忽略: ${path}`);
		} else {
			const modelsObj = modelsValue as Record<string, unknown>;
			for (const role of MODEL_ROLES) {
				const value = modelsObj[role];
				if (value === undefined) continue;
				if (isModelRef(value)) {
					models[role] = value;
				} else {
					warnings.push(`settings.json 的 models.${role} 形态非法，已忽略: ${JSON.stringify(value)}`);
				}
			}
		}
	}

	return { settings: { models }, warnings };
}
