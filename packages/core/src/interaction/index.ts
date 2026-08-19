// 轮中交互通道（创作规划 §6.7）模块导出。

export {
	InteractionBroker,
	InteractionUnavailableError,
	InteractionValidationError,
	InteractionTimeoutError,
} from "./broker.ts";
export type { InteractionHandler, InteractionRequest } from "./broker.ts";
export { judgeCombat } from "./combat.ts";
export type {
	CombatDifficulty,
	CombatJudgement,
	CombatJudgementInput,
	CombatOutcome,
} from "./combat.ts";
