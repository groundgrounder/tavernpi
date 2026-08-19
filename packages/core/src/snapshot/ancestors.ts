// 祖先链构建（薄适配：从 pi session entries 沿 parentId 回溯）。
// 不直接耦合 SessionManager —— 编排层把 entries 传进来即可。

export interface EntryLike {
	id: string;
	parentId: string | null;
}

/**
 * 构建目标 entry 的祖先链（含自身，从近到远）。
 * targetId 不存在 → 空链（调用方按空库兜底处理）。
 */
export function buildAncestorChain(entries: ReadonlyArray<EntryLike>, targetId: string): string[] {
	const byId = new Map<string, EntryLike>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}
	const chain: string[] = [];
	let current = byId.get(targetId);
	while (current) {
		chain.push(current.id);
		current = current.parentId !== null ? byId.get(current.parentId) : undefined;
	}
	return chain;
}
