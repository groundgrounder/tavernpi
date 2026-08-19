// 核心 schema（创作规划 §5.1 全量，严格按文档字段）。
// snapshots 表不在此处 —— §3.1：快照存独立 snapshots.db（M1-P2）。
// 所有 CREATE TABLE 用 IF NOT EXISTS，保证迁移崩溃后可幂等重跑。
// 「待 M2 校准」标注处 = 字段取值词汇/语义未在规划定案，由 M2 data subagent 契约校准。

export const CORE_SCHEMA_SQL = `
-- 时间（§5.1）
-- clock: 单例当前值，历史在 time_log；不带 turn_seq，是「所有写入带 turn_seq」原则的显式例外
-- "current_time" 加引号：current_time 是 SQLite 关键字（CURRENT_TIME），裸引用会被解析为当前时刻
CREATE TABLE IF NOT EXISTS clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  "current_time" TEXT NOT NULL,
  calendar TEXT NOT NULL,
  granularity TEXT NOT NULL
);

-- time_log: 每轮时间推进记录
CREATE TABLE IF NOT EXISTS time_log (
  turn_seq INTEGER NOT NULL,
  from_time TEXT NOT NULL,
  to_time TEXT NOT NULL,
  span_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_time_log_turn_seq ON time_log (turn_seq);

-- 叙事世界（§5.1）
-- events.type 取值词汇未定案（待 M2 校准），暂默认 'event' 自由文本
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_seq INTEGER NOT NULL,
  story_time TEXT,
  type TEXT NOT NULL DEFAULT 'event',
  summary TEXT NOT NULL,
  detail TEXT,
  participants TEXT,
  location TEXT,
  created_entry_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_turn_seq ON events (turn_seq);

-- phases: 故事阶段/幕。status 取值（active/ended...）待 M2 校准
CREATE TABLE IF NOT EXISTS phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  started_turn INTEGER NOT NULL,
  ended_turn INTEGER,
  goals TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

-- world_state: 天气、经济等键值（卡包命名空间前缀在加载层强制，见 §4.0）
CREATE TABLE IF NOT EXISTS world_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  turn_seq INTEGER NOT NULL
);

-- NPC（§5.1）。npcs 表本身无 turn_seq 列（状态覆盖型数据）
-- npcs.status: alive/dead/absent... 开放集合，待 M2 校准
CREATE TABLE IF NOT EXISTS npcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  card_ref TEXT,
  status TEXT NOT NULL DEFAULT 'alive'
);

-- npc_traits: 性格特征，可演化。(npc_id, trait, turn_seq) 主键保留每次演化快照；
-- 同一轮内同一 trait 重复写入会触发主键冲突（写者纪律的保护性报错）
CREATE TABLE IF NOT EXISTS npc_traits (
  npc_id INTEGER NOT NULL REFERENCES npcs(id),
  trait TEXT NOT NULL,
  weight REAL NOT NULL,
  source TEXT,
  turn_seq INTEGER NOT NULL,
  PRIMARY KEY (npc_id, trait, turn_seq)
);
CREATE INDEX IF NOT EXISTS idx_npc_traits_npc ON npc_traits (npc_id);

-- npc_memories: 记忆；salience 供检索排序，默认 0，衰减语义待 M2 校准
CREATE TABLE IF NOT EXISTS npc_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  npc_id INTEGER NOT NULL REFERENCES npcs(id),
  turn_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  salience REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_npc_memories_npc ON npc_memories (npc_id);

-- npc_relations: 关系/好感。disposition 参考 §5.2 favor 示例（-100~100，INTEGER）
CREATE TABLE IF NOT EXISTS npc_relations (
  npc_a INTEGER NOT NULL REFERENCES npcs(id),
  npc_b INTEGER NOT NULL REFERENCES npcs(id),
  disposition INTEGER NOT NULL DEFAULT 0,
  turn_seq INTEGER NOT NULL,
  PRIMARY KEY (npc_a, npc_b, turn_seq)
);

-- 一致性（§5.1）
-- turn_log: 每轮一行（PK turn_seq）。raw_text = stylize 前原文（未启用则同 narrative_text）
CREATE TABLE IF NOT EXISTS turn_log (
  turn_seq INTEGER PRIMARY KEY,
  session_entry_id TEXT NOT NULL,
  user_input TEXT NOT NULL,
  narrative_text TEXT NOT NULL,
  raw_text TEXT
);

-- directives: 创造模式剧情大纲指令（作者意图，非世界事实）；status 封闭枚举
CREATE TABLE IF NOT EXISTS directives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'revoked'))
);
`;
