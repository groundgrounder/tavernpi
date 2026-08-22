-- ============================================================
-- minipack schema.sql —— 卡包自定义表（创作规划 §5.2）
-- 命名空间契约（§4.0）：所有表名 / world_state 键必须以「minipack_」前缀开头。
-- ============================================================

-- minipack_tokens：玩家持有的凭证物清单（谁给了什么、能办什么事）。
CREATE TABLE IF NOT EXISTS minipack_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_ref TEXT NOT NULL UNIQUE,        -- 凭证 id（建议对应 collection/objects 条目 id，或自定义短键）
  name TEXT NOT NULL,                    -- 凭证名（面向玩家展示）
  note TEXT                              -- 备注（来源/用途/时效，data 维护）
);
