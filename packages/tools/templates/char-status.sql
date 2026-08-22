-- ============================================================
-- 模板：char-status 角色状态栏（创作规划 §5.2 常用表模板）
-- 用途：每个 NPC 一行，面板化状态（好感 / 生命 / 体力 / 情绪）。
--
-- 抄改步骤：
--   1) 把本文件内容复制进 db/schema.sql；
--   2) 把表名里的 PACKNAME 替换成你的包名——即 package.json 的 name，
--      须匹配 [a-z][a-z0-9_]*，直接作 SQL 前缀（不做任何转换）；
--   3) 按字段注释核对取值语义。字段注释就是 data subagent 的填写说明，
--      务必写清楚取值范围与默认行为（§5.2「注释即说明」）。
--
-- 命名空间契约（§4.0）：所有表名 / world_state 键必须带「包名_」前缀，
-- 加载器静态扫描强制，违规即加载失败。
-- ============================================================

-- 角色状态栏：每 NPC 一行；npc_ref 关联内核 npcs.card_ref（格式 包名:条目id）。
CREATE TABLE IF NOT EXISTS PACKNAME_char_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  npc_ref TEXT NOT NULL,                -- 关联 npcs.card_ref：格式 包名:条目id（如 myworld:liming）；查不到即为断链
  favor INTEGER NOT NULL DEFAULT 0,     -- 好感度：-100~100，初见通常为 0；正=友善，负=敌对（参考 §5.2 favor 示例）
  hp INTEGER NOT NULL DEFAULT 100,      -- 生命：0~hp_max；归 0 = 倒地/濒死（具体语义见世界设定）
  hp_max INTEGER NOT NULL DEFAULT 100,  -- 生命上限：随强化/状态变化，由 data 维护
  energy INTEGER NOT NULL DEFAULT 100,  -- 体力/精力：0~100；行动消耗、休息恢复
  mood TEXT,                            -- 情绪快照：自由文本（如 平静/愤怒/悲伤），描述性而非数值
  turn_seq INTEGER NOT NULL,            -- 最近一次更新的轮次（与内核 turn_seq 一致，留审计/回溯用）
  note TEXT,                            -- 附加备注（可选）
  UNIQUE (npc_ref)                      -- 每 NPC 一行：npc_ref 唯一，seed 幂等键
);

-- 示例种子数据（常规做法放 seed.sql；schema.sql 里给初值也行）。
-- INSERT OR IGNORE：按 npc_ref 幂等，重复执行不产生重复行（§4.1 seed 幂等纪律）。
INSERT OR IGNORE INTO PACKNAME_char_status (npc_ref, favor, hp, hp_max, energy, mood, turn_seq) VALUES
  ('myworld:liming', 5, 100, 100, 80, '平静', 0);
