// subagent 运行时（创作规划 §6.0 总则 + 技术路线 §3.3）。
// 每个 subagent 一轮 = 一个空白 inMemory session + 单输出工具强制结构化输出：
// 白名单收紧到输出工具（tools 显式 allowlist，避免 noTools:"all" 连 customTools 一起过滤），
// 输出工具带 constrainedSampling(json_schema, require) 让 provider 侧约束输出形态。
//
// 提示词责任在调用方（P2 编排器）：systemPrompt/userPrompt 里强制「必须调用输出工具」；
// runtime 只在 prompt 结束后检查输出工具是否被调用——未调用 → 抛 SubagentOutputError。
// 输出工具参数校验失败的容错（重试/降级）留给 P2；runtime 只透传捕获值 as T。
//
// usage 从 session.getSessionStats() 提取（输入/输出/缓存 token 与总成本），durationMs 墙钟；
// finally 里 session.dispose()。会话零落盘（SessionManager.inMemory），不调 session.reload()。

import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	type CreateAgentSessionOptions,
	type ModelRuntime,
	type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * 模型类型：从 createAgentSession 的选项推导，等价于 pi-ai 的 Model<any>，
 * 避免把 @earendil-works/pi-ai 直接列为依赖（其本为 pi-coding-agent 的传递依赖）。
 */
type SubagentModel = NonNullable<CreateAgentSessionOptions["model"]>;

export interface SubagentOutputTool {
	name: string;
	description: string;
	/** 输出参数 schema（typebox）。经 constrainedSampling(json_schema, require) 约束 provider 侧输出。 */
	schema: TSchema;
}

export interface SubagentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number;
}

export interface SubagentRunOptions {
	/** 事件流/日志标识（如 narrator/data），用于错误信息与后续事件记录。 */
	role: string;
	cwd: string;
	/** 经 DefaultResourceLoader 的 systemPromptOverride 整体替换系统提示。 */
	systemPrompt: string;
	/** 编排器注入的上下文 + 任务指令。 */
	userPrompt: string;
	/** 唯一白名单工具。 */
	outputTool: SubagentOutputTool;
	/** 缺省走 pi 默认模型解析（createAgentSession 内置逻辑）。 */
	model?: SubagentModel;
	/** 多 subagent 并行纪律：共享一个 ModelRuntime 实例（凭证/模型共享）。 */
	modelRuntime?: ModelRuntime;
}

export interface SubagentResult<T> {
	output: T;
	usage: SubagentUsage;
	durationMs: number;
}

/** 模型未调用输出工具 / 输出缺失。 */
export class SubagentOutputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubagentOutputError";
	}
}

/** 把 pi SessionStats 映射为 subagent usage（costTotal 缺省 0）。 */
export function mapSubagentUsage(stats: SessionStats): SubagentUsage {
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		totalTokens: stats.tokens.total,
		costTotal: stats.cost ?? 0,
	};
}

export async function runSubagent<T = unknown>(options: SubagentRunOptions): Promise<SubagentResult<T>> {
	const sessionManager = SessionManager.inMemory(options.cwd);

	// 资源加载器：提示词/技能/扩展全关，系统提示整体替换为 subagent 自己的提示词。
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		systemPromptOverride: () => options.systemPrompt,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: () => ({ skills: [], diagnostics: [] }),
		promptsOverride: () => ({ prompts: [], diagnostics: [] }),
	});
	await loader.reload();

	// 单输出工具：execute 捕获 arguments 到闭包，返回简短 ack。
	// constrainedSampling(json_schema, require)：ToolDefinition 原生字段，provider 侧约束输出。
	let captured: unknown;
	const outputTool = defineTool({
		name: options.outputTool.name,
		label: options.outputTool.name,
		description: options.outputTool.description,
		parameters: options.outputTool.schema,
		constrainedSampling: { type: "json_schema", strict: "require" },
		execute: async (_toolCallId, params) => {
			captured = params;
			return { content: [{ type: "text", text: `已收到 ${options.outputTool.name} 结构化输出` }], details: { ok: true } };
		},
	});

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: options.cwd,
		sessionManager,
		resourceLoader: loader,
		customTools: [outputTool],
		tools: [options.outputTool.name], // 严格白名单：只留输出工具
		model: options.model,
		modelRuntime: options.modelRuntime,
	});
	if (modelFallbackMessage) {
		console.warn(`[subagent:${options.role}] ${modelFallbackMessage}`);
	}

	const startedAt = Date.now();
	let stats: SessionStats;
	try {
		await session.prompt(options.userPrompt);
		stats = session.getSessionStats();
	} finally {
		session.dispose();
	}
	const durationMs = Date.now() - startedAt;

	if (captured === undefined) {
		throw new SubagentOutputError(
			`subagent(${options.role}) 未调用输出工具 ${options.outputTool.name}，结构化输出缺失`,
		);
	}
	return {
		output: captured as T,
		usage: mapSubagentUsage(stats),
		durationMs,
	};
}
