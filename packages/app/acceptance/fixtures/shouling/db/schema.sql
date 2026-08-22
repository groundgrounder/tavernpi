-- ============================================================
-- shouling schema.sql —— 卡包自定义表（创作规划 §5.2）
-- 命名空间契约（§4.0）：所有表名 / world_state 键必须以「shouling_」前缀开头。
-- 字段注释 = data subagent 的填写说明（§5.2「注释即说明」），填值时严格按注释约束。
-- ============================================================

-- shouling_favor：沈秋对玩家的信任度（状态覆盖型：每轮由 data UPDATE 当前行，不追加历史）。
CREATE TABLE IF NOT EXISTS shouling_favor (
  npc_ref TEXT PRIMARY KEY,              -- 关联 npcs.card_ref，本包固定 'shouling:shen-qiu'；一行一个 NPC
  favor INTEGER NOT NULL DEFAULT 0,      -- 信任度：-100~100，初见为 0；正=信任，负=戒备/敌意；跌破 -50 时沈秋拒绝同行或隐瞒关键信息
  last_turn INTEGER NOT NULL DEFAULT 0,  -- 最近更新轮次（与内核 turn_seq 一致，供回溯审计）
  note TEXT                              -- 备注（可选）：促成信任变化的叙事原因摘要
);
