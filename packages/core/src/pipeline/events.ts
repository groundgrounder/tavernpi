// pipeline 事件流骨架（创作规划 §10.2：各 subagent 的输入/输出/耗时/成本观测；M2 起承诺面）。
// 事件是结构化留痕（独立于叙事文本）：每行一个 JSON 对象（JSONL），
// record 同步 appendFileSync + 同步通知 listeners。
//
// 容错纪律：
// - listener 抛错：捕获并忽略（不炸 pipeline）。
// - 文件写失败：不抛；仅首次 console.warn 去重（避免吞掉静默埋雷，又不打断 pipeline）。
// - inputChars/outputChars 只记规模不记全文，控制日志体积。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SubagentUsage } from "../subagent/runtime.ts";

export interface PipelineEvent {
	/** ISO 时间戳。 */
	ts: string;
	turnSeq: number;
	/** 角色标识（narrator/data/…）。 */
	role: string;
	ok: boolean;
	durationMs: number;
	/** 重试序号（1 基）。 */
	attempt?: number;
	usage?: SubagentUsage;
	/** 输入规模观测（不记全文）。 */
	inputChars?: number;
	outputChars?: number;
	error?: string;
}

export type PipelineEventListener = (e: PipelineEvent) => void;

export interface PipelineEventLog {
	record(e: PipelineEvent): void;
	/** 订阅；返回退订函数。 */
	on(l: PipelineEventListener): () => void;
	/** JSONL 文件路径（未提供时为纯内存模式）。 */
	readonly filePath?: string;
}

export function createPipelineEventLog(filePath?: string): PipelineEventLog {
	const listeners = new Set<PipelineEventListener>();
	let warnedWriteError = false;
	return {
		filePath,
		record(e: PipelineEvent): void {
			if (filePath !== undefined) {
				try {
					mkdirSync(dirname(filePath), { recursive: true });
					appendFileSync(filePath, `${JSON.stringify(e)}\n`);
				} catch (err) {
					// 写失败吞掉但首次告警（去重），不抛——事件流是观测设施，不能炸 pipeline。
					if (!warnedWriteError) {
						warnedWriteError = true;
						console.warn(
							`[pipeline-events] 写入事件日志失败（仅首次告警）: ${filePath}: ${(err as Error).message}`,
						);
					}
				}
			}
			for (const listener of listeners) {
				try {
					listener(e);
				} catch {
					// listener 抛错捕获并忽略——通知是尽力而为。
				}
			}
		},
		on(listener: PipelineEventListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
