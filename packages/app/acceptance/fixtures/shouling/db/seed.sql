-- ============================================================
-- shouling seed.sql —— 种子数据（幂等：INSERT OR IGNORE + 主键去重）
-- ============================================================

INSERT OR IGNORE INTO shouling_favor (npc_ref, favor, last_turn) VALUES ('shouling:shen-qiu', 0, 0);
