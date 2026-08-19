// combat_check 演示工具的判定规则（纯函数，确定性、可测）。
// 把轮中交互结果（行动方式 choice + 全力一搏 confirm）映射为 success/partial/failure 判定。
// 位于 core 以便单测覆盖；m1-cli 的 combat_check 工具消费本规则。

export type CombatDifficulty = "easy" | "normal" | "hard";
export type CombatOutcome = "success" | "partial" | "failure";

export interface CombatJudgementInput {
	difficulty: CombatDifficulty;
	/** choice 选中项序号：0=稳扎稳打 / 1=冒险突进 / 2=伺机闪避。 */
	choiceOption: number;
	/** confirm 结果：是否全力一搏（+2 加值）。 */
	allIn: boolean;
}

export interface CombatJudgement {
	outcome: CombatOutcome;
	score: number;
	hint: string;
}

/** 判定阈值（difficulty → 所需分数）。 */
const TARGET: Record<CombatDifficulty, number> = { easy: 5, normal: 6, hard: 7 };

/** 选项基础分（0=稳扎稳打 4 / 1=冒险突进 5 / 2=伺机闪避 3）。 */
const CHOICE_SCORE: readonly number[] = [4, 5, 3];

const HINTS: Record<CombatOutcome, string> = {
	success: "判定通过：行动干脆利落，局面尽在掌握。",
	partial: "判定部分成功：目标达成，但付出代价或横生波折。",
	failure: "判定失败：局面急转直下，需要设法挽回。",
};

/**
 * 判定规则：score = 选项基础分 + 全力一搏加成(2)。
 * outcome：score ≥ target → success；score ≥ target-1 → partial；否则 failure。
 */
export function judgeCombat(input: CombatJudgementInput): CombatJudgement {
	const target = TARGET[input.difficulty];
	const base = CHOICE_SCORE[input.choiceOption] ?? 0;
	const score = base + (input.allIn ? 2 : 0);
	const outcome: CombatOutcome = score >= target ? "success" : score >= target - 1 ? "partial" : "failure";
	return { outcome, score, hint: HINTS[outcome] };
}
