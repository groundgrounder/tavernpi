-- ============================================================
-- 模板：quest-progress 任务进度（创作规划 §5.2 常用表模板）
-- 用途：每个任务一行（或多行里程碑），随剧情推进更新。
--
-- 抄改步骤同 char-status：把表名里的 PACKNAME 替换成你的包名
-- （package.json 的 name，须匹配 [a-z][a-z0-9_]*，直接作 SQL 前缀）；字段注释 = data 填写说明。
--
-- 设计注意：
--   - quest_id 建议对应 collection/plot 条目（包名:条目id），主线/支线同表；
--   - status 用 CHECK 封闭枚举，防手写 SQL 写进脏值（沿内核 v3 data_status 的约束风格）；
--   - stage 从 0 起：0=未开始/刚接取，随剧情推进 +1（各阶段含义在注释或 plot 条目里定死）。
-- ============================================================

CREATE TABLE IF NOT EXISTS PACKNAME_quest_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quest_id TEXT NOT NULL,                          -- 任务 id：建议 = collection/plot 条目 id（包名:条目id）
  title TEXT NOT NULL,                             -- 任务名（面向玩家展示）
  stage INTEGER NOT NULL DEFAULT 0,                -- 当前阶段序号：0 起；每个阶段的含义在下方注释/plot 条目里定义
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','failed','abandoned')),
  summary TEXT,                                    -- 进度摘要：2~3 句话描述当前进展（data 每轮维护，供注入渲染）
  updated_turn INTEGER NOT NULL,                   -- 最近更新轮次
  note TEXT,                                       -- 备注（可选）
  UNIQUE (quest_id)                                -- 每任务一行：quest_id 唯一，seed 幂等键
);

-- 示例种子数据（INSERT OR IGNORE：按 quest_id 幂等，重复执行不产生重复行，§4.1 seed 幂等纪律）：
INSERT OR IGNORE INTO PACKNAME_quest_progress (quest_id, title, stage, status, summary, updated_turn) VALUES
  ('myworld:royal-tomb', '守陵人委托', 0, 'active', '刚接下委托，需前往王城东侧的陵墓查明异动。', 0);
