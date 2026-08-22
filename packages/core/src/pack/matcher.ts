// 检索式注入匹配引擎（创作规划 §4.1 匹配语义 M5 定稿 / §8 决策行「检索式注入引擎」）。
//
// 语义（全部确定性，零 LLM）：
//   - 匹配：大小写不敏感子串（toLowerCase + includes），扫描文本 = input + (recentNarrative ?? "")；
//     keys 任一命中即触发。
//   - 通道：手动钉 > 常驻（always_on）> 触发；触发多条按命中数降序、同数按 包名:type:id 字典序。
//   - 预算：token 估算 = ceil(text.length / 2)，默认 1500。整条注入或整条裁掉；
//     单条自身超预算 → 截断正文 + warning；被裁条目 warning（含条目标识）。
//   - 渲染（紧凑，给主叙事读）：`## <name>（<type>）\n<body>\n【关联】\n- <refs 摘要行>...`；
//     position=system 进 systemText（前部基调区），recent 进 recentText。

import type { CollectionEntry, WorldPack } from "./types.ts";

export interface CollectionInjectionOptions {
	/** 本轮玩家输入（扫描文本的一部分）。 */
	input: string;
	/** 最近 1 轮叙事文本（可选；扫描文本的一部分）。 */
	recentNarrative?: string;
	/** 手动钉，写法 `包名:type:id`；未知 pin → warning 忽略。 */
	pinned?: string[];
	/** token 预算（默认 1500，可按故事覆盖）。 */
	budgetTokens?: number;
}

export interface CollectionInjectionResult {
	/** position=system 条目的渲染（系统提示前部基调区）。 */
	systemText: string;
	/** position=recent 条目的渲染（贴近最新叙事）。 */
	recentText: string;
	warnings: string[];
	/** 命中条目标识（包名:type:id；含截断注入的条目）。 */
	injected: string[];
}

/** token 估算：text.length / 2 向上取整（中文友好近似）。 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 2);
}

const DEFAULT_BUDGET_TOKENS = 1500;

interface Candidate {
	entry: CollectionEntry;
	/** 包名:type:id。 */
	ident: string;
	/** 触发命中数（触发通道排序用；pinned/常驻为 0）。 */
	hits: number;
}

/**
 * 构建本轮注入串。packs 须已通过加载校验（引用完整、前缀合法）。
 */
export function buildCollectionInjection(
	packs: WorldPack[],
	opts: CollectionInjectionOptions,
): CollectionInjectionResult {
	const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
	const warnings: string[] = [];

	// 全局索引：包名:type:id → 条目（pinned 解析 + refs 摘要行解析共用）
	const entryByIdent = new Map<string, CollectionEntry>();
	for (const pack of packs) {
		for (const entry of pack.entries) {
			entryByIdent.set(`${pack.name}:${entry.type}:${entry.id}`, entry);
		}
	}

	// 1) 手动钉（未知 pin → warning 忽略；去重保序）
	const pinned: Candidate[] = [];
	const seen = new Set<string>();
	for (const pin of opts.pinned ?? []) {
		const entry = entryByIdent.get(pin);
		if (entry === undefined) {
			warnings.push(`未知手动钉: ${pin}（已忽略）`);
			continue;
		}
		if (!seen.has(pin)) {
			seen.add(pin);
			pinned.push({ entry, ident: pin, hits: 0 });
		}
	}

	// 2) 常驻（always_on，未钉；按 包名:type:id 字典序，确定性）
	const alwaysOn: Candidate[] = [];
	for (const pack of packs) {
		for (const entry of pack.entries) {
			if (!entry.alwaysOn) continue;
			const ident = `${pack.name}:${entry.type}:${entry.id}`;
			if (seen.has(ident)) continue;
			seen.add(ident);
			alwaysOn.push({ entry, ident, hits: 0 });
		}
	}
	alwaysOn.sort((a, b) => a.ident.localeCompare(b.ident));

	// 3) 触发（keys 任一命中；按命中数降序、同数按 包名:type:id 字典序）
	const scanText = `${opts.input}\n${opts.recentNarrative ?? ""}`.toLowerCase();
	const triggered: Candidate[] = [];
	for (const pack of packs) {
		for (const entry of pack.entries) {
			if (seen.has(`${pack.name}:${entry.type}:${entry.id}`)) continue;
			const hits = entry.keys.filter((k) => k.length > 0 && scanText.includes(k.toLowerCase())).length;
			if (hits > 0) {
				triggered.push({ entry, ident: `${pack.name}:${entry.type}:${entry.id}`, hits });
			}
		}
	}
	triggered.sort((a, b) => b.hits - a.hits || a.ident.localeCompare(b.ident));

	// 预算内按优先级排序注入：钉 > 常驻 > 触发
	const candidates: Candidate[] = [...pinned, ...alwaysOn, ...triggered];
	let remaining = budget;
	const systemParts: string[] = [];
	const recentParts: string[] = [];
	const injected: string[] = [];

	for (const { entry, ident } of candidates) {
		const refLines = resolveRefSummaryLines(entry, entryByIdent);
		const full = renderEntry(entry, refLines);
		const tokens = estimateTokens(full);
		if (tokens <= remaining) {
			appendInjection(systemParts, recentParts, injected, entry, full, ident);
			remaining -= tokens;
			continue;
		}
		// 整条放不下：
		//  - 单条自身超预算（整条 > 总预算，永远无法整条注入）→ 截断正文注入 + warning
		//  - 否则 → 整条裁减 + warning（不半截截断）
		if (tokens > budget) {
			const truncated = truncateEntry(entry, refLines, remaining);
			if (truncated !== null) {
				appendInjection(systemParts, recentParts, injected, entry, truncated, ident);
				remaining = 0;
				warnings.push(`条目超预算，正文已截断: ${ident}`);
				continue;
			}
		}
		warnings.push(`预算不足，整条裁减: ${ident}`);
	}

	return {
		systemText: systemParts.join("\n\n"),
		recentText: recentParts.join("\n\n"),
		warnings,
		injected,
	};
}

/** 命中条目的 refs 展开一级摘要行（被引条目未命中也展开；引用完整性已由加载器保证）。 */
function resolveRefSummaryLines(entry: CollectionEntry, entryByIdent: Map<string, CollectionEntry>): string[] {
	const lines: string[] = [];
	for (const ref of entry.refs) {
		const parts = ref.split(":");
		if (parts.length === 2) {
			const target = entryByIdent.get(`${entry.pack}:${parts[0]}:${parts[1]}`);
			if (target !== undefined) lines.push(target.summaryLine);
		} else if (parts.length === 3) {
			const target = entryByIdent.get(`${parts[0]}:${parts[1]}:${parts[2]}`);
			if (target !== undefined) lines.push(target.summaryLine);
		}
	}
	return lines;
}

/** 条目渲染：`## <name>（<type>）\n<body>\n【关联】\n- <refs 摘要行>...`（【关联】仅在有 refs 行时出现）。 */
function renderEntry(entry: CollectionEntry, refLines: string[]): string {
	const parts = [`## ${entry.name}（${entry.type}）`, entry.body];
	if (refLines.length > 0) {
		parts.push(`【关联】\n${refLines.map((l) => `- ${l}`).join("\n")}`);
	}
	return parts.join("\n");
}

/** 按剩余预算截断正文（头部与【关联】段不裁）。放不下（剩余为 0/过小）返回 null → 整条裁减。 */
function truncateEntry(entry: CollectionEntry, refLines: string[], remainingTokens: number): string | null {
	const header = `## ${entry.name}（${entry.type}）\n`;
	const refsBlock = refLines.length > 0 ? `\n【关联】\n${refLines.map((l) => `- ${l}`).join("\n")}` : "";
	const overheadChars = header.length + refsBlock.length;
	const maxBodyChars = Math.max(0, remainingTokens * 2 - overheadChars);
	if (maxBodyChars <= 0) return null;
	const body = truncateChars(entry.body, maxBodyChars);
	return `${header}${body}${refsBlock}`;
}

/** 按码点截断（中文友好）。 */
function truncateChars(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** 按 position 分流进 systemText / recentText，并记入 injected。 */
function appendInjection(
	systemParts: string[],
	recentParts: string[],
	injected: string[],
	entry: CollectionEntry,
	render: string,
	ident: string,
): void {
	if (entry.position === "system") {
		systemParts.push(render);
	} else {
		recentParts.push(render);
	}
	injected.push(ident);
}
