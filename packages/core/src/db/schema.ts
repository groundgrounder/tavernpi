// 核心 schema（创作规划 §5.1 全量，严格按文档字段）。
// snapshots 表不在此处 —— §3.1：快照存独立 snapshots.db（M1-P2）。
// 所有 CREATE TABLE 用 IF NOT EXISTS，保证迁移崩溃后可幂等重跑。
// 「待 M2 校准」标注处 = 字段取值词汇/语义未在规划定案，由 M2 data subagent 契约校准。
// v1 = 基础 schema（M1 已交付，已被旧故事库记录在 schema_migrations）；空间基元在 v2
// （CORE_V2_SPATIAL_SQL + CORE_V2_ALTERS，见 migrate.ts）——既有 v1 库 open 后原地升 v2，
// 新库 v1→v2 顺序应用直达当前版本。

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

/**
 * v2「spatial-primitives」（创作规划 §5.1 空间基元 / §8 决策行）——新表部分。
 * 最小内核基元：locations 注册表 + 玩家位置（world_state 约定键 player_location）+
 * location_log；完整地图拓扑/移动规则由卡包 SQL 自定义，内核不强制。
 */
export const CORE_V2_SPATIAL_SQL = `
-- ---------- 空间基元（§5.1 / §8 决策行） ----------
-- locations: 地点注册表。parent_id 表达包含关系（如 王城>庭院），不构成完整拓扑，内核不校验连通性。
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- 地点名（data subagent 用 registered 名字，不造别名）
  parent_id INTEGER REFERENCES locations(id),  -- 父地点（包含关系；无父为 NULL）
  detail TEXT                            -- 地点描述（可空）
);

-- location_log: 位置变更记录，镜像 time_log（§5.1）。
-- subject 约定 = 'player'（玩家）或 'npc:<id>'（NPC）；from = 移动前位置，to = 移动后位置。
CREATE TABLE IF NOT EXISTS location_log (
  turn_seq INTEGER NOT NULL,             -- 变更发生的轮次
  subject TEXT NOT NULL,                 -- 'player' 或 'npc:<id>'
  from_location INTEGER REFERENCES locations(id),  -- 移动前位置（首移为 NULL）
  to_location INTEGER REFERENCES locations(id),    -- 移动后位置
  note TEXT                              -- 移动说明（可空）
);
CREATE INDEX IF NOT EXISTS idx_location_log_turn_seq ON location_log (turn_seq);
`;

/**
 * v2 对旧表的新增列（既有 v1 库原地升级用；新库 v1→v2 同样走——用列存在性守卫幂等）。
 * 选择说明：node:sqlite 对 ALTER TABLE ADD COLUMN 带 REFERENCES 支持已实证（foreign_keys ON
 * 下合法、FK 在新列上生效、旧行默认 NULL），故用原地 ALTER 而非「建新表+复制+rename」。
 */
export const CORE_V2_ALTERS: ReadonlyArray<{ table: string; column: string; sql: string }> = [
	{
		table: "npcs",
		column: "current_location",
		sql: "ALTER TABLE npcs ADD COLUMN current_location INTEGER REFERENCES locations(id)",
	},
	{
		table: "events",
		column: "location_id",
		sql: "ALTER TABLE events ADD COLUMN location_id INTEGER REFERENCES locations(id)",
	},
];

/**
 * v3「data-status」（§6.1 失败路径持久化）——新表部分。
 * data subagent 每轮落库状态：ok / failed（本轮失败待补）/ compensated（后续轮补齐）。
 * 快照 guard（snapshot/hooks.ts）用它在「有成功落库轮却无快照」与「全 failed 合法态」之间裁决。
 */
export const CORE_V3_DATA_STATUS_SQL = `
-- ---------- data subagent 落库状态（§6.1 / §7 M2） ----------
-- turn_seq PK：每轮一行。attempts = 该轮落库尝试次数；error = 失败原因摘要（成功为 NULL）。
-- 约束用 CHECK 封闭 status 取值（防手写 SQL 绕过类型层）。
CREATE TABLE IF NOT EXISTS data_status (
  turn_seq INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'compensated')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
`;
