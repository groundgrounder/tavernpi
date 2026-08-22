#!/usr/bin/env node
// tavernpi-pack：卡包校验 / 试跑 / 模板工具链（创作规划 §5.2「工具链提供 schema 校验与试跑」、
// 技术路线 §7 M5）。受众 = 卡作者：默认输出人类可读中文；--json 输出机器可读结果（编辑器集成）。
//
// 命令：
//   tavernpi-pack check [--json] <packDir...>  默认命令（无命令参数时即 check）。对卡包目录：
//       1) loadPacks：加载 + 全量校验（条目 zod strict / 引用完整性含跨包 / 命名空间前缀静态扫描 /
//          id 冲突），失败时逐条打印「file: message」，退出码 1；
//       2) 干净内存库试跑迁移：core 迁移 + <包名>_schema / <包名>_seed 命名迁移，两遍 migrate 验证幂等；
//       3) 只读冒烟：列 sqlite_master 中带包前缀的自建表与行数、npcs/locations seed 行数。
//   tavernpi-pack templates [<id>] [--json]    列出内置 SQL 表模板（§5.2「常用表模板可直接抄改」）；
//                                              带 <id> 时打印该模板完整 SQL（供复制）。
//   tavernpi-pack init <dir>                   生成最小可过检的骨架包。
//   tavernpi-pack --help / --version
//
// pack API 来自 packages/core/src/pack/（loadPacks / packMigrations / PackLoadError / WorldPack）。

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	loadPacks,
	migrate,
	packMigrations,
	type CollectionEntry,
	type Migration,
	PackLoadError,
	type WorldPack,
} from "@tavernpi/core";
import { findTemplate, listTemplates, readTemplateSql } from "./templates.ts";

const VERSION = "0.0.0";

// ---------------------------------------------------------------------------
// 错误与报告类型
// ---------------------------------------------------------------------------

/** 迁移失败并归因到具体卡包文件（schema.sql / seed.sql）。 */
class MigrationError extends Error {
	readonly file: string;
	constructor(file: string, message: string) {
		super(message);
		this.name = "MigrationError";
		this.file = file;
	}
}

interface PackTableSmoke {
	pack: string;
	name: string;
	rows: number;
}

interface CheckReport {
	ok: boolean;
	command: "check";
	errors: Array<{ file?: string; message: string }>;
	packs?: Array<{
		name: string;
		dir: string;
		entries: number;
		entriesByType: Record<string, number>;
		hasCode: boolean;
		tables: Array<{ name: string; rows: number }>;
	}>;
	seed?: { npcs: number; locations: number };
	migrations?: { applied: string[]; rerunApplied: string[] };
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

type Command = "check" | "templates" | "init";

interface CliOptions {
	command: Command;
	json: boolean;
	help: boolean;
	version: boolean;
	args: string[];
}

/**
 * 手写解析（沿 m4-cli 风格，不引依赖）。命令只认第一个非 flag 参数，
 * 其余一律视为位置参数（卡包目录 / 模板 id / 目标目录）。
 */
function parseArgs(argv: readonly string[]): CliOptions {
	const opts: CliOptions = { command: "check", json: false, help: false, version: false, args: [] };
	let firstNonFlag = true;
	for (const a of argv) {
		if (a === "--json") {
			opts.json = true;
		} else if (a === "--help" || a === "-h") {
			opts.help = true;
		} else if (a === "--version" || a === "-v") {
			opts.version = true;
		} else {
			if (firstNonFlag && (a === "check" || a === "templates" || a === "init")) {
				opts.command = a;
			} else {
				opts.args.push(a);
			}
			firstNonFlag = false;
		}
	}
	return opts;
}

// ---------------------------------------------------------------------------
// check：加载 → 迁移试跑 → 只读冒烟
// ---------------------------------------------------------------------------

async function runCheck(packDirs: string[], json: boolean): Promise<number> {
	const report: CheckReport = { ok: false, command: "check", errors: [] };
	const dirs = packDirs.map((d) => resolve(d));

	if (dirs.length === 0) {
		report.errors.push({ message: "缺少卡包目录参数：tavernpi-pack check <packDir...>" });
		return finishCheck(report, json);
	}

	// 目录存在性预检（错误信息指到具体路径，先于人肉逐个读报错）
	for (const d of dirs) {
		if (!existsSync(d)) {
			report.errors.push({ file: d, message: "目录不存在" });
		} else if (!statSync(d).isDirectory()) {
			report.errors.push({ file: d, message: "不是目录（期望卡包目录）" });
		}
	}
	if (report.errors.length > 0) {
		return finishCheck(report, json);
	}

	// 1) 加载 + 全量校验（zod strict / 引用完整性含跨包 / 前缀静态扫描 / id 冲突）
	let packs: WorldPack[];
	try {
		packs = loadPacks(dirs);
	} catch (error) {
		if (error instanceof PackLoadError) {
			report.errors.push(...error.issues.map((i) => ({ file: i.file, message: i.message })));
		} else {
			report.errors.push({
				file: packDirs[0],
				message: error instanceof Error ? error.message : String(error),
			});
		}
		return finishCheck(report, json);
	}

	// 2) 干净内存库试跑迁移（core + 卡包命名迁移，schema.sql/seed.sql 可执行且幂等）
	let migrations: Migration[];
	try {
		migrations = packMigrations(packs);
	} catch (error) {
		report.errors.push({ message: error instanceof Error ? error.message : String(error) });
		return finishCheck(report, json);
	}

	let migrationsResult: { applied: string[]; rerunApplied: string[] };
	let smoke: { tables: PackTableSmoke[]; npcs: number; locations: number };
	{
		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON"); // 与 openStoryDb 一致：FK 生效下校验 seed 引用
		try {
			migrationsResult = applyPackMigrations(db, migrations);
			smoke = smokeQuery(db, packs);
		} catch (error) {
			if (error instanceof MigrationError) {
				report.errors.push({ file: error.file, message: error.message });
			} else {
				report.errors.push({ message: error instanceof Error ? error.message : String(error) });
			}
			db.close();
			return finishCheck(report, json);
		}
		db.close();
	}

	report.ok = true;
	report.packs = packs.map((p) => ({
		name: p.name,
		dir: p.dir,
		entries: p.entries.length,
		entriesByType: countByType(p.entries),
		hasCode: p.hasCode,
		tables: smoke.tables.filter((t) => t.pack === p.name),
	}));
	report.seed = { npcs: smoke.npcs, locations: smoke.locations };
	report.migrations = migrationsResult;
	return finishCheck(report, json);
}

/**
 * 应用迁移（core 内置 + 卡包命名迁移）并验证幂等。
 * 说明：migrate(db, extraMigrations) 本身已内置 CORE_MIGRATIONS，不能把 CORE_MIGRATIONS 再放进
 * extraMigrations——migrate 的 applied 集合不随循环更新，重复迁移名会在 schema_migrations.name
 * UNIQUE 约束上撞车。这里 core 一次、每个卡包迁移单独一次（顺序与 migrate(db, 全量) 等价），
 * 顺带获得 schema.sql / seed.sql 的失败归因。
 */
function applyPackMigrations(
	db: DatabaseSync,
	packMigrations: Migration[],
): { applied: string[]; rerunApplied: string[] } {
	const applied = migrate(db); // core 内置迁移（v1..v4）
	for (const m of packMigrations) {
		try {
			applied.push(...migrate(db, [m]));
		} catch (error) {
			const file = m.name.endsWith("_seed") ? "db/seed.sql" : "db/schema.sql";
			throw new MigrationError(
				file,
				`迁移 ${m.name} 失败：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	// 幂等重跑：整批再 migrate 一次，应无新迁移（schema_migrations 已全量登记）
	const rerunApplied = migrate(db, packMigrations);
	return { applied, rerunApplied };
}

/** 只读冒烟：包前缀自建表与行数 + npcs/locations seed 行数。 */
function smokeQuery(
	db: DatabaseSync,
	packs: WorldPack[],
): { tables: PackTableSmoke[]; npcs: number; locations: number } {
	const tables: PackTableSmoke[] = [];
	for (const pack of packs) {
		const prefix = `${pack.name}_`;
		// substr 前缀匹配而非 LIKE（前缀含 '_'，LIKE 会把 '_' 当单字符通配）
		const rows = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, ?) = ? ORDER BY name")
			.all(prefix.length, prefix) as Array<{ name: string }>;
		for (const { name } of rows) {
			const quoted = `"${name.replaceAll('"', '""')}"`;
			const { c } = db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get() as { c: number };
			tables.push({ pack: pack.name, name, rows: c });
		}
	}
	const npcs = (db.prepare("SELECT COUNT(*) AS c FROM npcs").get() as { c: number }).c;
	const locations = (db.prepare("SELECT COUNT(*) AS c FROM locations").get() as { c: number }).c;
	return { tables, npcs, locations };
}

function countByType(entries: CollectionEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const e of entries) {
		counts[e.type] = (counts[e.type] ?? 0) + 1;
	}
	return counts;
}

// ---------------------------------------------------------------------------
// check：输出
// ---------------------------------------------------------------------------

function finishCheck(report: CheckReport, json: boolean): number {
	if (json) {
		printJson(report);
	} else if (report.ok) {
		printCheckOk(report);
	} else {
		printCheckErrors(report);
	}
	return report.ok ? 0 : 1;
}

function printCheckErrors(report: CheckReport): void {
	console.error("✖ 卡包校验未通过");
	for (const e of report.errors) {
		console.error(e.file !== undefined ? `  ${e.file}: ${e.message}` : `  ${e.message}`);
	}
	console.error("修复后重新运行；常见报错对照见 packages/tools/README.md");
}

function printCheckOk(report: CheckReport): void {
	console.log("✔ 卡包加载通过");
	for (const p of report.packs ?? []) {
		const types = Object.entries(p.entriesByType)
			.map(([t, n]) => `${t} ${n}`)
			.join("、");
		console.log(`  [${p.name}] ${p.dir}`);
		console.log(`    条目 ${p.entries}（${types}）· ${p.hasCode ? "含代码" : "纯内容包"}`);
	}

	const m = report.migrations!;
	console.log("✔ 迁移试跑（干净内存库）");
	console.log(`  应用 ${m.applied.length} 个迁移: ${m.applied.join(", ")}`);
	if (m.rerunApplied.length === 0) {
		console.log("  幂等重跑: 无新迁移（两遍 migrate 无副作用 ✓）");
	} else {
		console.log(`  幂等重跑: 追加了迁移 ${m.rerunApplied.join(", ")}（异常，请检查 schema.sql/seed.sql）`);
	}

	console.log("✔ 只读冒烟");
	for (const p of report.packs ?? []) {
		if (p.tables.length === 0) {
			console.log(`  [${p.name}] 无包前缀自定义表（前缀 ${p.name}_）`);
		} else {
			console.log(`  [${p.name}] 包自建表（前缀 ${p.name}_）:`);
			for (const t of p.tables) {
				console.log(`    - ${t.name}: ${t.rows} 行`);
			}
		}
	}
	const seed = report.seed!;
	console.log(`  seed 行数: npcs=${seed.npcs} · locations=${seed.locations}`);
}

// ---------------------------------------------------------------------------
// templates：列出 / 打印内置 SQL 表模板
// ---------------------------------------------------------------------------

async function runTemplates(args: string[], json: boolean): Promise<number> {
	const templates = listTemplates();

	if (args.length === 0) {
		if (json) {
			printJson({
				ok: true,
				command: "templates",
				templates: templates.map((t) => ({ id: t.id, title: t.title, description: t.description, file: t.file })),
			});
		} else {
			console.log("内置 SQL 表模板（创作规划 §5.2「常用表模板可直接抄改」）");
			console.log("");
			console.log("模板 SQL 里的表名用 PACKNAME 占位：把 PACKNAME 替换成你的包名");
			console.log("（即 package.json 的 name，须匹配 [a-z][a-z0-9_]*，直接作 SQL 前缀）。");
			console.log("复制进 db/schema.sql 后按字段注释填写取值语义——字段注释就是");
			console.log("data subagent 的填写说明（§5.2「注释即说明」）。");
			console.log("");
			for (const t of templates) {
				console.log(`  ${t.id.padEnd(14)} ${t.title}`);
				console.log(`                  ${t.description}`);
			}
			console.log("");
			console.log(`用法: tavernpi-pack templates <id> 打印模板完整 SQL（${templates.map((t) => t.id).join(" / ")}）`);
		}
		return 0;
	}

	const id = args[0]!;
	const template = findTemplate(id);
	if (template === null) {
		const message = `未知模板: ${id}（可用: ${templates.map((t) => t.id).join(", ")}）`;
		if (json) {
			printJson({ ok: false, command: "templates", errors: [{ message }] });
		} else {
			console.error(`✖ ${message}`);
		}
		return 1;
	}

	if (json) {
		printJson({
			ok: true,
			command: "templates",
			template: { id: template.id, title: template.title, sql: readTemplateSql(template) },
		});
	} else {
		console.log(readTemplateSql(template));
	}
	return 0;
}

// ---------------------------------------------------------------------------
// init：生成最小可过检的骨架包
// ---------------------------------------------------------------------------

async function runInit(args: string[], json: boolean): Promise<number> {
	const dirArg = args[0];
	if (dirArg === undefined) {
		const message = "init 需要目录参数：tavernpi-pack init <dir>";
		if (json) {
			printJson({ ok: false, command: "init", errors: [{ message }] });
		} else {
			console.error(`✖ ${message}`);
		}
		return 1;
	}

	const dir = resolve(dirArg);
	const packName = sanitizePackName(basename(dir)) ?? "demo_world";

	// 拒绝覆盖已有卡包（防手滑清空既有作品）
	if (existsSync(dir) && (existsSync(join(dir, "package.json")) || existsSync(join(dir, "story.yaml")))) {
		const message = `目录已存在卡包文件（package.json 或 story.yaml），拒绝覆盖: ${dir}`;
		if (json) {
			printJson({ ok: false, command: "init", errors: [{ message }] });
		} else {
			console.error(`✖ ${message}`);
		}
		return 1;
	}

	const files = [
		["package.json", skeletonPackageJson(packName)],
		["story.yaml", skeletonStoryYaml()],
		["collection/characters/example.yaml", skeletonExampleEntry()],
		["db/schema.sql", skeletonSchemaSql(packName)],
		["db/seed.sql", skeletonSeedSql(packName)],
	] as const;

	mkdirSync(join(dir, "collection", "characters"), { recursive: true });
	mkdirSync(join(dir, "db"), { recursive: true });
	for (const [rel, content] of files) {
		writeFileSync(join(dir, rel), content);
	}

	if (json) {
		printJson({
			ok: true,
			command: "init",
			dir,
			packName,
			prefix: `${packName}_`,
			files: files.map(([rel]) => rel),
		});
	} else {
		console.log(`✔ 已生成骨架卡包: ${dir}`);
		console.log(`  包名: ${packName}（SQL 表前缀: ${packName}_）`);
		console.log("  文件:");
		for (const [rel] of files) {
			console.log(`    ${rel}`);
		}
		console.log("");
		console.log(`  下一步: tavernpi-pack check ${dir}`);
	}
	return 0;
}

/**
 * 目录名 → 包名。包名即 SQL 前缀（types.ts PACK_NAME_RE = ^[a-z][a-z0-9_]*$，
 * 直接作前缀、不做转换，故只允许小写字母数字下划线）。
 */
function sanitizePackName(raw: string): string | null {
	const name = raw
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^[^a-z]+/, "") // 首字符必须是 a-z
		.replace(/_+$/, "");
	if (name === "") {
		return null;
	}
	return name;
}

// ---------------------------------------------------------------------------
// init：骨架文件内容（字段注释即填写说明）
// ---------------------------------------------------------------------------

function skeletonPackageJson(packName: string): string {
	return `${JSON.stringify(
		{
			name: packName,
			version: "0.1.0",
			private: true,
			type: "module",
			pi: {}, // pi manifest（§3.1 核实）：纯内容包无 extensions/skills/prompts/themes，留空即可
		},
		null,
		2,
	)}\n`;
}

function skeletonStoryYaml(): string {
	return `# 作品级元数据（创作规划 §4.1）。字段名与 core pack 加载器 storyMetaSchema 一致
#（宽松解析：多余字段会被忽略，但字段名用下面的就不会丢）。

title: 我的世界
calendar: default        # 历法（§5.3）：default = 现实公历；自定义历法名后续版本支持
granularity: elastic     # 时间粒度：elastic（弹性时间）/ tick（回合制）/ real（真实历）
opening: 你在一座山脚下醒来，雾气未散。  # 开场白：故事第一轮的主叙事种子
defaultStyle: 平实克制的中文叙事     # 默认文风（§6.4，仅供 stylize 阶段消费）
`;
}

function skeletonExampleEntry(): string {
	return `# 条目格式（创作规划 §4.1）：文件名即条目 id（example）。
# 通用字段: type（= 目录名）/ name / keys / always_on / position / refs —— zod strict，未知字段报错。
# character 特化字段: identity / personality / voice? / dialogue_examples?。
# 引用写作 type:id（包内）或 包名:type:id（跨包），断链由加载器校验并报错。

type: character
name: 示例角色
keys: [示例]
always_on: false        # 常驻（蓝灯）；false = 触发（绿灯）
position: system        # 插入位置: system（系统提示前部）/ recent（贴近最新叙事）
refs: []                # 交叉引用: [type:id] 或 [包名:type:id]
identity: |
  两句话核心人设：这个人是谁、立场是什么、最深的执念或弱点。
personality: |
  性格调色盘 / 三面性：表面表现、遇险反应、私下状态。
voice: |                # 可选: 该角色口吻指导；缺省用 story.yaml 默认文风
  冷静简短，少用形容词，用短句。
dialogue_examples: []   # 可选: 1~3 条示范对话
`;
}

function skeletonSchemaSql(packName: string): string {
	return `-- ============================================================
-- ${packName} schema.sql —— 卡包自定义表（创作规划 §5.2）
--
-- 命名空间（§4.0 契约）：所有表名 / world_state 键必须以「${packName}_」前缀开头
-- （内核保留表/键白名单除外），加载器静态扫描强制，违规即加载失败。
--
-- 字段注释 = data subagent 的填写说明：每个字段都要写清取值语义与范围
-- （如 favor: -100~100，初见通常为 0），不要另搞一套说明文件（§5.2「注释即说明」）。
--
-- 常用表模板（可直接抄改，§5.2）：
--   tavernpi-pack templates                 # 列出全部模板
--   tavernpi-pack templates char-status     # 打印模板 SQL（复制后把表名里的 PACKNAME 换成 ${packName}）
--   内置模板: char-status（角色状态栏）/ inventory（物品栏）/ quest-progress（任务进度）
--
-- 本文件保持「最小可过检」：只有注释、无任何表。加表 = 复制模板进来替换前缀。
-- ============================================================
`;
}

function skeletonSeedSql(packName: string): string {
	return `-- ============================================================
-- ${packName} seed.sql —— 卡包种子数据（幂等：重复执行不炸）
--
-- 初值/预设数据放这里；表必须先在上面的 schema.sql 定义。
-- character/location 条目的自动 seed 由内核在故事创建时完成
-- （npcs.card_ref = 包名:条目id / locations 按 name），本文件只需写卡包自定义表的初值。
-- INSERT 幂等：用 INSERT OR IGNORE，或先查存在性再插入。
-- ============================================================
`;
}

// ---------------------------------------------------------------------------
// 帮助 / 入口
// ---------------------------------------------------------------------------

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
	console.log(`tavernpi-pack ${VERSION} —— 卡包校验 / 试跑 / 模板工具链（创作规划 §5.2）

用法:
  tavernpi-pack check [--json] <packDir...>  校验卡包（默认命令；<packDir> 至少 1 个）
  tavernpi-pack templates [<id>] [--json]    列出内置 SQL 表模板（带 <id> 打印完整 SQL）
  tavernpi-pack init <dir>                   生成最小可过检的骨架包
  tavernpi-pack --help / --version

选项:
  --json             机器可读输出（编辑器集成）
  --help, -h         显示本帮助
  --version, -v      显示版本

示例:
  tavernpi-pack check ./my_world
  npm run pack:check -- ./my_world
  tavernpi-pack templates char-status
  tavernpi-pack init ./my_world`);
}

export async function main(argv: readonly string[]): Promise<number> {
	const opts = parseArgs(argv);
	if (opts.help) {
		printHelp();
		return 0;
	}
	if (opts.version) {
		console.log(`tavernpi-pack ${VERSION}`);
		return 0;
	}
	switch (opts.command) {
		case "check":
			return runCheck(opts.args, opts.json);
		case "templates":
			return runTemplates(opts.args, opts.json);
		case "init":
			return runInit(opts.args, opts.json);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[错误] ${message}`);
			process.exitCode = 1;
		});
}
