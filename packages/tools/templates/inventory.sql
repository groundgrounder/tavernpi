-- ============================================================
-- 模板：inventory 物品栏（创作规划 §5.2 常用表模板）
-- 用途：持有者 ↔ 物品清单；玩家与 NPC 通用。
--
-- 抄改步骤同 char-status：把表名里的 PACKNAME 替换成你的包名
-- （package.json 的 name，须匹配 [a-z][a-z0-9_]*，直接作 SQL 前缀）；字段注释 = data 填写说明。
--
-- 设计注意：
--   - 持有者 owner_ref：'player'（玩家）或 npcs.card_ref（包名:条目id）；
--   - 主键 (owner_ref, item_id) 防重复：同持有者同物品只一行，数量变化 UPDATE 当前行；
--   - 物品标识 item_id 建议复用 collection/objects 条目 id（包名:条目id），
--     未知物品 id 时 data 应质疑而非静默新建。
-- ============================================================

CREATE TABLE IF NOT EXISTS PACKNAME_inventory (
  owner_ref TEXT NOT NULL,              -- 持有者：'player' 或 npcs.card_ref（包名:条目id）
  item_id TEXT NOT NULL,                -- 物品 id：建议 = collection/objects 条目 id（包名:条目id）
  name TEXT NOT NULL,                   -- 物品名（面向玩家展示，不必等于 item_id）
  count INTEGER NOT NULL DEFAULT 1,     -- 数量：>= 1；消耗类物品归 0 时删除该行
  category TEXT,                        -- 分类：武器/防具/消耗品/任务物品/材料...（开放集合）
  quality TEXT,                         -- 品质：普通/精良/稀有/传说...（开放集合）
  equipped INTEGER NOT NULL DEFAULT 0,  -- 是否装备：1=已装备，0=未装备（每人同部位限一件由 data 保证）
  note TEXT,                            -- 备注：来源/特殊效果/耐久等
  turn_seq INTEGER NOT NULL,            -- 最近更新轮次
  PRIMARY KEY (owner_ref, item_id)
);

-- 示例种子数据（INSERT OR IGNORE：按主键幂等，重复执行不产生重复行，§4.1 seed 幂等纪律）：
INSERT OR IGNORE INTO PACKNAME_inventory (owner_ref, item_id, name, count, category, equipped, note, turn_seq) VALUES
  ('player', 'myworld:bronze-token', '青铜令牌', 1, '任务物品', 0, '守陵人令牌，进出的凭证', 0);
