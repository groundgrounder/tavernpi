# tavernpi-pack —— 卡包校验 / 试跑 / 模板工具链

`@tavernpi/tools` 是卡包系统（M5）给**卡作者**用的命令行工具。它只做三件事：

1. **check**：加载并全量校验卡包（条目格式、引用完整性、命名空间前缀、SQL），在干净内存库里试跑 `schema.sql` / `seed.sql`，并做只读冒烟查询。
2. **templates**：内置 SQL 表模板库（角色状态栏 / 物品栏 / 任务进度），可直接抄改。
3. **init**：生成一个「最小可过检」的骨架卡包。

相关契约：创作规划 §4（世界包）/ §5.2（变量系统，SQL 是一等创作接口）。

```bash
npm run pack:check -- ./my-world   # 或直接 node packages/tools/src/cli.ts check ./my-world
```

---

## 1. 快速开始

```bash
# 1) 生成骨架卡包
node packages/tools/src/cli.ts init ./my_world

# 2) 校验它
node packages/tools/src/cli.ts check ./my_world
# ✔ 卡包加载通过
# ✔ 迁移试跑（干净内存库）
# ✔ 只读冒烟

# 3) 加一张表：挑个模板抄进 db/schema.sql
node packages/tools/src/cli.ts templates
node packages/tools/src/cli.ts templates char-status
```

---

## 2. 世界包布局

一个世界包 = 一部作品的完整设定（设定集 + SQL + 可选代码），是一个普通目录：

```
my-world/
├── package.json        # pi manifest（纯内容包只需 {"pi": {}}；包名即命名空间前缀来源）
├── story.yaml          # 作品级元数据：标题、历法/粒度、开场白、默认文风
├── collection/         # 设定集：目录树，每条目一文件，文件名即条目 id
│   ├── characters/     # type=character：主角与 NPC 同构
│   ├── locations/      # type=location：seed locations 注册表
│   ├── objects/        # type=object：关键物品
│   ├── factions/       # type=faction：势力/组织
│   └── plot/           # type=plot：剧情线/大纲
├── prompts/            # 可选：覆盖 subagent 提示词（§6.5）
└── db/
    ├── schema.sql      # 本包自定义表（CREATE TABLE，可含初值 INSERT）
    └── seed.sql        # 种子数据（INSERT；重复执行不炸）
```

- **纯内容包零代码**：不需要写任何 extension 代码，YAML 条目 + SQL 即完整卡包。
- `package.json` 的 `name` 被用作命名空间前缀与跨包引用前缀（见 §5）。
- `schema.sql` / `seed.sql` 在故事创建时以命名迁移执行（`<包名>_schema` / `<包名>_seed`），幂等。

---

## 3. 条目字段表

条目通用结构（每条目一 YAML 文件，文件名即条目 id）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | string | ✅ | 必须 = 所在目录名（characters → `character` 等），加载器校验一致 |
| `name` | string | ✅ | 展示名 |
| `keys` | string[] | ✅ | 触发词（绿灯）；空数组 = 仅常驻/手动钉 |
| `always_on` | bool | ✅ | 常驻（蓝灯）；`false` = 触发 |
| `position` | `system` \| `recent` | ✅ | 插入位置：系统提示前部 / 贴近最新叙事 |
| `refs` | string[] | ✅ | 交叉引用：`type:id`（包内）或 `包名:type:id`（跨包）；断链报错 |

各类型特化字段（同样 zod strict，未知字段报错）：

| 类型 | 特化字段 |
|---|---|
| `character` | `identity`、`personality`、`voice?`、`dialogue_examples?` |
| `location` | `overview`、`features[]` |
| `object` | `overview`、`properties[]` |
| `faction` | `overview`、`goals[]`、`members[]`（refs） |
| `plot` | `overview`、`beats[]`、`status` |

> zod strict 的意义：**笔误优于静默吞掉**。多打了字段、拼错了字段名，check 会直接报错指出文件与行，而不是默默忽略。

---

## 4. SQL 子集（卡作者只需掌握这些）

`schema.sql` / `seed.sql` 里只用两种语句：

```sql
-- 建表
CREATE TABLE IF NOT EXISTS <包名>_char_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  npc_ref TEXT NOT NULL,        -- 字段注释 = data subagent 的填写说明
  favor INTEGER NOT NULL DEFAULT 0,  -- favor: -100~100，初见通常为 0
  turn_seq INTEGER NOT NULL
);

-- 种子数据（建议放 seed.sql；幂等用 INSERT OR IGNORE 或先查再插）
INSERT OR IGNORE INTO <包名>_char_status (npc_ref, favor, turn_seq) VALUES ('my_world:liming', 5, 0);
```

规则：

- **不用学**视图、触发器、存储过程、复杂查询。卡包表是「内容本体」——data subagent 只填表，读取渲染与状态界面由内核负责。
- 所有 `CREATE TABLE` 用 `IF NOT EXISTS`；INSERT 幂等（`INSERT OR IGNORE` 或存在性判断）——卡包 SQL 会被重复执行。
- 不要在 SQL 里写内嵌注释以外的说明文档。**字段注释就是给 data subagent 的填写说明**（§5.2）：每个字段写清取值语义与范围（`favor: -100~100，初见通常为 0`），语义与结构在同一处维护。
- 卡包自定义表 M5 不进入 data 变更集（data 只写内核固定表）；自定义表的写入由卡包代码工具或后续里程碑扩展。

---

## 5. 命名空间前缀规则（§4.0 契约）

- **表名、world_state 键**必须带「`包名_`」前缀（内核保留表/键白名单除外）。
- 前缀 = `package.json` 的 `name`，**直接作前缀、不做转换**：name 须匹配 `^[a-z][a-z0-9_]*$`（小写字母开头，仅小写字母/数字/下划线）。这也是加载器的包名校验，不满足即加载失败。
- 加载器**静态扫描** SQL 文本强制此规则：裸表名、非白名单内核表名、无前缀的 world_state 键 → 加载失败报错到人。
- 跨包引用写作 `包名:条目id`；包内条目 id 唯一，冲突即加载失败。

---

## 6. 命令参考

### `tavernpi-pack check [--json] <packDir...>`

默认命令（不带任何命令参数时即 check）。对卡包目录依次做：

1. **加载 + 全量校验**：条目 zod strict、引用完整性（含跨包）、命名空间前缀静态扫描、id 冲突。任一失败 → 逐条打印 `file: message`，退出码 1。
2. **迁移试跑**：干净内存库（`:memory:`，`foreign_keys = ON`）上执行 `migrate(db, packMigrations(packs))`——core 内置迁移 + 每包的 `<包名>_schema` / `<包名>_seed`。跑**两遍**验证幂等（schema_migrations 追踪，第二遍无新迁移即通过）。失败时错误归因到 `db/schema.sql` 或 `db/seed.sql`。
3. **只读冒烟**：列出 `sqlite_master` 中带包前缀的自建表与行数、`npcs` / `locations` seed 行数。

```
✔ 卡包加载通过
  [my-world] /path/to/my-world
    条目 3（character 2、location 1）· 纯内容包
✔ 迁移试跑（干净内存库）
  应用 6 个迁移: v1_core_schema, v2_spatial_primitives, v3_data_status, v4_turn_log_warnings, myworld_schema, myworld_seed
  幂等重跑: 无新迁移（两遍 migrate 无副作用 ✓）
✔ 只读冒烟
  [my-world] 包自建表（前缀 myworld_）:
    - myworld_char_status: 2 行
  seed 行数: npcs=2 · locations=3
```

`--json`：输出机器可读 JSON（编辑器集成）：

```json
{
  "ok": true,
  "command": "check",
  "packs": [ { "name": "my-world", "dir": "/abs/path", "entries": 3, "entriesByType": {"character": 2, "location": 1}, "hasCode": false, "tables": [{"name": "myworld_char_status", "rows": 2}] } ],
  "seed": { "npcs": 2, "locations": 3 },
  "migrations": { "applied": ["v1_core_schema", "..."], "rerunApplied": [] }
}
```

失败时 `{ "ok": false, "errors": [{ "file": "...", "message": "..." }] }`。

### `tavernpi-pack templates [<id>] [--json]`

列出内置 SQL 表模板；带 `<id>` 时打印该模板完整 SQL（复制进 `db/schema.sql` 抄改）。

内置模板：`char-status`（角色状态栏，favor -100~100）/ `inventory`（物品栏）/ `quest-progress`（任务进度）。模板 SQL 自带前缀占位说明与字段注释。

### `tavernpi-pack init <dir>`

生成最小可过检的骨架包：

```
<dir>/package.json
<dir>/story.yaml
<dir>/collection/characters/example.yaml
<dir>/db/schema.sql     # 只有注释：说明前缀规则与模板用法，可过检
<dir>/db/seed.sql       # 只有注释
```

目标目录已有 `package.json` / `story.yaml` 时拒绝覆盖。

### `--help` / `--version`

---

## 7. 常见报错对照

| 报错形态 | 含义 | 处理 |
|---|---|---|
| `<file>: 未知字段 xxx` | 条目写了 zod schema 之外的多余字段（笔误/拼错） | 删掉或改对字段名（§3 字段表） |
| `<file>: 引用断链: xxx` | `refs` 或条目内引用的 `type:id` 找不到目标条目 | 补目标条目，或把引用改成已有的 `type:id` / `包名:type:id` |
| `<file>: 表名缺少包前缀` | `CREATE TABLE` 表名没有 `包名_` 前缀 | 改名加前缀（§5） |
| `<file>: id 冲突: xxx` | 条目 id（文件名）重复 | 重命名条目文件 |
| `<file>: 迁移 <包名>_schema 失败: ...` | `schema.sql` 在该包表上有 SQL 错误 | 按 SQL 错误修 `db/schema.sql`；迁移是在干净内存库上从零跑的 |
| `<file>: 迁移 <包名>_seed 失败: ...` | `seed.sql` 执行失败 | 常见：表没建（放错文件）、INSERT 撞约束、FK 引用不存在的行；修 `db/seed.sql` |
| `幂等重跑: 追加了迁移 ...` | 同一批迁移第二遍仍有新迁移被应用（异常） | 检查 `schema_migrations` 语义或 SQL 是否按迁移规范编写 |

## 8. 开发备注

- `check` 的 pack API（`loadPacks` / `packMigrations` / `PackLoadError`）来自 `packages/core/src/pack/`（Lane A 契约）。加载层出现 `loadPacks` 抛出的运行时错误时，属 core 侧在途问题，由 orchestrator 收尾。
- 根目录 `npm run pack:check -- <packDir...>` 即等价于 `node packages/tools/src/cli.ts check <packDir...>`。
- 本包不参与根 `npm run typecheck`（其只覆盖 core 与 app）；独立类型检查：`npx tsc -p packages/tools/tsconfig.json`。
