// InteractionBroker：轮中交互通道（创作规划 §6.7）——小游戏/判定 UI 的挂载点。
//
// 契约（§6.7）：
// - 卡包自定义工具可在执行中发起轮中交互：挂起 await 玩家响应，响应经工具声明的
//   responseSchema 校验后返回；无 UI handler 时工具收到可辨识错误（InteractionUnavailableError），
//   自行降级为文本提问或默认分支，不崩溃、不挂死。
// - 交互请求/响应走单一通道（registerHandler）；TUI 与外部 UI 各自实现自己的 handler。
//
// 机制：
// - kind 开放命名空间：内置 confirm / choice / text；卡包自定义 `包名:kind`（如 combat:qte）。
//   内核不校验 kind 格式（约定层），但未知 kind 由 handler 抛错（让工具降级路径可见）。
// - responseSchema 用 typebox（与 subagent 结构化输出同一套）：typebox/value 的 Check + Errors。
// - M1 阶段 m1-cli 注册 readline handler（confirm/choice/text 可玩）；富渲染后续按 kind 增强，
//   接口不变。M6 随 §10.2 纳入承诺面。

import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

/** 一次轮中交互请求（§6.7 机制节）。 */
export interface InteractionRequest {
	/** kind 开放命名空间：内置 confirm/choice/text；卡包自定义 包名:kind（约定层，内核不校验格式）。 */
	kind: string;
	/** 呈现给玩家的提示文本。 */
	prompt: string;
	/** kind 特定的开放参数（如 choice 的 options 选项列表、小游戏参数）。 */
	payload?: unknown;
	/** 响应 schema（typebox；响应不过校验 → 工具收到 InteractionValidationError）。 */
	responseSchema: TSchema;
	/** 超时毫秒；缺省 = 不超时（由 UI 自行控制节奏）。 */
	timeoutMs?: number;
}

/** UI 层注册的交互 handler。返回值须符合请求声明的 responseSchema。 */
export type InteractionHandler = (req: InteractionRequest) => Promise<unknown>;

/** 交互通道不可用（未注册 handler）。工具 catch 此错误降级（§6.7 降级契约）。 */
export class InteractionUnavailableError extends Error {
	readonly kind: string;
	constructor(kind: string) {
		super(`轮中交互不可用：未注册 handler（kind=${kind}）。工具应降级为默认分支或文本提问（§6.7）`);
		this.name = "InteractionUnavailableError";
		this.kind = kind;
	}
}

/** 交互响应未通过 responseSchema 校验（含校验细节）。工具可据此重问或降级。 */
export class InteractionValidationError extends Error {
	readonly kind: string;
	readonly received: unknown;
	constructor(kind: string, schema: TSchema, received: unknown) {
		let details = "未知校验错误";
		try {
			const list = [...Errors(schema, received)];
			if (list.length > 0) {
				details = list
					.map((e) => {
						const path = "path" in e && typeof e.path === "string" ? e.path : "$";
						const message = "message" in e ? String(e.message) : "非法值";
						return `${path === "" ? "$" : path}: ${message}`;
					})
					.join("; ");
			}
		} catch {
			// Errors 对极端输入可能抛错；不影响主错误抛出
		}
		super(`轮中交互响应未通过 responseSchema 校验（kind=${kind}）：${details}`);
		this.name = "InteractionValidationError";
		this.kind = kind;
		this.received = received;
	}
}

/** 交互超时（timeoutMs 内未获响应）。 */
export class InteractionTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(timeoutMs: number) {
		super(`轮中交互超时（${timeoutMs}ms 内未获响应）`);
		this.name = "InteractionTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

/**
 * 轮中交互单一通道。UI 层经 registerHandler 注册实现；工具经 request 发起交互。
 * 重复 registerHandler = 替换：UI 切换/重建时重注册即接管（单一 handler，无多路订阅）。
 */
export class InteractionBroker {
	private handler: InteractionHandler | undefined;

	/** 注册 UI handler（重复注册 = 替换，无需显式注销）。 */
	registerHandler(handler: InteractionHandler): void {
		this.handler = handler;
	}

	/**
	 * 发起交互并返回校验后的响应。
	 * - 无 handler → {@link InteractionUnavailableError}；
	 * - handler 返回值不过 responseSchema → {@link InteractionValidationError}（含校验细节）；
	 * - timeoutMs 内未完成 → {@link InteractionTimeoutError}。
	 */
	async request<T extends TSchema>(req: InteractionRequest & { responseSchema: T }): Promise<Static<T>> {
		const handler = this.handler;
		if (handler === undefined) {
			throw new InteractionUnavailableError(req.kind);
		}
		const raw = await withTimeout(handler(req), req.timeoutMs);
		if (!Check(req.responseSchema, raw)) {
			throw new InteractionValidationError(req.kind, req.responseSchema, raw);
		}
		return raw as Static<T>;
	}
}

/** 超时包装：缺省不超时；超时抛 InteractionTimeoutError。迟到 settle 不产生未处理拒绝。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
	if (timeoutMs === undefined) return promise;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new InteractionTimeoutError(timeoutMs)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
