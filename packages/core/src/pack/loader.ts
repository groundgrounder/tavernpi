// 世界包自研加载器（创作规划 §4.1 加载形态 M5 定稿 / §8 决策行「卡包加载形态」）。
// 纯内容包由本模块直接读目录树，不走 pi package 自动发现；代码包（index.ts / pi.extensions）
// 只收集入口（hasCode / extensionEntryPaths），实际加载执行在 Lane C 经 SDK 委托 pi loader。
//
// 目录布局（§4.1）：
//   package.json           name 必填，须匹配 ^[a-z][a-z0-9_]*$（直接作 SQL 前缀，不转换）
//   story.yaml             可选，缺失 = 空 StoryMeta
//   collection/<type>/<id>.yaml
//                          type 必须与目录一致；id（文件名去 .yaml）包内跨 type 唯一
//   db/schema.sql          必填（内容可为空）；db/seed.sql 可选
//   prompts/               可选，本 lane 不消费（Lane C 提示词分层加载）
//   index.ts / pi.extensions 声明（可选，只收集不加载）
//
// 校验语义：
//   - 条目通用字段 + 特化字段 zod strict，未知字段报错到人（笔误优于静默吞掉）；
//   - refs = `[包名:]type:id`；包内引用在 loadPack 校验，跨包引用在 loadPacks 校验，
//     断链收集进 PackLoadError（报错到人，含文件名）；
//   - db/schema.sql + db/seed.sql 文本静态扫描：表名须 `<包名>_` 前缀（内核保留表白名单豁免，
//     但卡包 SQL 写内核表本身即报错）；
//   - story.yaml 解析失败 / 坏 YAML → PackLoadError。
// 失败即 PackLoadError，一次收集全部问题（校验工具/UI 可整屏展示）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	ENTRY_ID_RE,
	ENTRY_POSITIONS,
	ENTRY_TYPES,
	PACK_NAME_RE,
	PackLoadError,
	type CollectionEntry,
	type EntryType,
	type PackIssue,
	type StoryMeta,
	type WorldPack,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 条目 zod strict schema（§4.1 条目格式定稿）
// ---------------------------------------------------------------------------

const commonFields = {
	name: z.string().min(1),
	keys: z.array(z.string()).default([]),
	always_on: z.boolean().default(false),
	position: z.enum(ENTRY_POSITIONS).default("system"),
	refs: z.array(z.string()).default([]),
};

const characterSpecialized = {
	identity: z.string(),
	personality: z.string(),
	voice: z.string().optional(),
	dialogue_examples: z.array(z.string()).optional(),
};

const locationSpecialized = {
	overview: z.string(),
	features: z.array(z.string()),
	// v0：父地点条目 id（同包引用，§5.1 父子地点）；seed 时先种父再种子。消费在 seed.ts。
	parent: z.string().optional(),
};

const objectSpecialized = {
	overview: z.string(),
	properties: z.array(z.string()),
};

const factionSpecialized = {
	overview: z.string(),
	goals: z.array(z.string()),
	members: z.array(z.string()), // refs 形式 `[包名:]type:id`，引用完整性一并校验
};

const plotSpecialized = {
	overview: z.string(),
	beats: z.array(z.string()),
	status: z.string(),
};

// 每变体 type 用 z.literal（discriminatedUnion 要求判别值唯一；type 与目录一致性在加载层另校验）
const characterEntrySchema = z.object({ type: z.literal("character"), ...commonFields, ...characterSpecialized }).strict();
const locationEntrySchema = z.object({ type: z.literal("location"), ...commonFields, ...locationSpecialized }).strict();
const objectEntrySchema = z.object({ type: z.literal("object"), ...commonFields, ...objectSpecialized }).strict();
const factionEntrySchema = z.object({ type: z.literal("faction"), ...commonFields, ...factionSpecialized }).strict();
const plotEntrySchema = z.object({ type: z.literal("plot"), ...commonFields, ...plotSpecialized }).strict();

const entrySchema = z.discriminatedUnion("type", [
	characterEntrySchema,
	locationEntrySchema,
	objectEntrySchema,
	factionEntrySchema,
	plotEntrySchema,
]);

type ParsedEntry = z.infer<typeof entrySchema>;

/** 各类型特化字段名（data = 仅这些字段，不含通用字段）。 */
const SPECIALIZED_FIELDS: Record<EntryType, readonly string[]> = {
	character: ["identity", "personality", "voice", "dialogue_examples"],
	location: ["overview", "features", "parent"],
	object: ["overview", "properties"],
	faction: ["overview", "goals", "members"],
	plot: ["overview", "beats", "status"],
};

// ---------------------------------------------------------------------------
// story.yaml schema（宽松：未知字段 strip；本 lane 只解析）
// ---------------------------------------------------------------------------

const storyMetaSchema = z.object({
	title: z.string().optional(),
	calendar: z.string().optional(),
	granularity: z.string().optional(),
	opening: z.string().optional(),
	defaultStyle: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 工具：zod 错误消息 / 正文渲染 / 摘要行
// ---------------------------------------------------------------------------

/** zod 校验错误 → 单行可读消息（含字段路径）。 */
function zodIssueMessage(error: z.ZodError): string {
	return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** 按码点截断（中文友好，计数「字」）。 */
function truncateChars(text: string, max: number): string {
	const chars = [...text];
	return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** 特化字段 → 注入用正文渲染（紧凑 markdown；确定性，零 LLM）。 */
function renderEntryBody(type: EntryType, data: Record<string, unknown>): string {
	const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
	const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
	switch (type) {
		case "character": {
			const lines: string[] = [];
			const identity = str(data.identity);
			if (identity !== undefined) lines.push(`身份：${identity}`);
			const personality = str(data.personality);
			if (personality !== undefined) lines.push(`性格：${personality}`);
			const voice = str(data.voice);
			if (voice !== undefined) lines.push(`口吻：${voice}`);
			const examples = list(data.dialogue_examples);
			if (examples.length > 0) {
				lines.push("对话示例：");
				lines.push(...examples.map((e) => `- ${e}`));
			}
			return lines.join("\n");
		}
		case "location": {
			const lines: string[] = [];
			const overview = str(data.overview);
			if (overview !== undefined) lines.push(`概述：${overview}`);
			const features = list(data.features);
			if (features.length > 0) {
				lines.push("特色：");
				lines.push(...features.map((f) => `- ${f}`));
			}
			return lines.join("\n");
		}
		case "object": {
			const lines: string[] = [];
			const overview = str(data.overview);
			if (overview !== undefined) lines.push(`概述：${overview}`);
			const props = list(data.properties);
			if (props.length > 0) {
				lines.push("属性：");
				lines.push(...props.map((p) => `- ${p}`));
			}
			return lines.join("\n");
		}
		case "faction": {
			const lines: string[] = [];
			const overview = str(data.overview);
			if (overview !== undefined) lines.push(`概述：${overview}`);
			const goals = list(data.goals);
			if (goals.length > 0) {
				lines.push("目标：");
				lines.push(...goals.map((g) => `- ${g}`));
			}
			const members = list(data.members);
			if (members.length > 0) {
				lines.push("成员：");
				lines.push(...members.map((m) => `- ${m}`));
			}
			return lines.join("\n");
		}
		case "plot": {
			const lines: string[] = [];
			const overview = str(data.overview);
			if (overview !== undefined) lines.push(`概述：${overview}`);
			const beats = list(data.beats);
			if (beats.length > 0) {
				lines.push("节拍：");
				lines.push(...beats.map((b) => `- ${b}`));
			}
			const status = str(data.status);
			if (status !== undefined) lines.push(`状态：${status}`);
			return lines.join("\n");
		}
	}
}

/** summaryLine = name + 首非空行截 60 字（refs 一级摘要行内容，§4.1）。 */
function buildSummaryLine(name: string, body: string): string {
	const first = body.split("\n").find((l) => l.trim() !== "");
	if (first === undefined) return name;
	return `${name}：${truncateChars(first.trim(), 60)}`;
}

// ---------------------------------------------------------------------------
// 引用解析（[包名:]type:id）
// ---------------------------------------------------------------------------

type ParsedRef = { ok: true; pack: string; type: EntryType; id: string } | { ok: false; message: string };

/** 解析引用项：`type:id`（包内，pack=""）或 `包名:type:id`（跨包）。格式/取值非法返回错误原因。 */
function parseRef(ref: string): ParsedRef {
	const parts = ref.split(":");
	if (parts.length === 2) {
		const type = parts[0];
		const id = parts[1];
		if (type === undefined || !ENTRY_TYPES.includes(type as EntryType)) {
			return { ok: false, message: `非法引用类型 ${JSON.stringify(type)}` };
		}
		if (id === undefined || !ENTRY_ID_RE.test(id)) {
			return { ok: false, message: `非法条目 id ${JSON.stringify(id)}` };
		}
		return { ok: true, pack: "", type: type as EntryType, id };
	}
	if (parts.length === 3) {
		const pack = parts[0];
		const type = parts[1];
		const id = parts[2];
		if (pack === undefined || !PACK_NAME_RE.test(pack)) {
			return { ok: false, message: `非法包名 ${JSON.stringify(pack)}` };
		}
		if (type === undefined || !ENTRY_TYPES.includes(type as EntryType)) {
			return { ok: false, message: `非法引用类型 ${JSON.stringify(type)}` };
		}
		if (id === undefined || !ENTRY_ID_RE.test(id)) {
			return { ok: false, message: `非法条目 id ${JSON.stringify(id)}` };
		}
		return { ok: true, pack, type: type as EntryType, id };
	}
	return { ok: false, message: `格式非法（应为 [包名:]type:id）` };
}

/** 条目携带的全部引用：refs 字段 + faction.members（members 按定义也是 refs）。 */
function entryRefs(entry: { refs: string[]; type: EntryType; data: Record<string, unknown> }): string[] {
	const refs = [...entry.refs];
	if (entry.type === "faction") {
		const members = entry.data.members;
		if (Array.isArray(members)) {
			for (const m of members) {
				if (typeof m === "string") refs.push(m);
			}
		}
	}
	return refs;
}

// ---------------------------------------------------------------------------
// package.json / story.yaml / collection / 代码入口
// ---------------------------------------------------------------------------

interface PackageJson {
	name?: unknown;
	pi?: { extensions?: unknown };
}

function readPackageJson(dir: string, issues: PackIssue[]): PackageJson {
	const path = join(dir, "package.json");
	if (!existsSync(path)) {
		issues.push({ file: path, message: "package.json 缺失（世界包必须带 pi manifest 的 package.json）" });
		return {};
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PackageJson;
	} catch (err) {
		issues.push({ file: path, message: `package.json 解析失败: ${(err as Error).message}` });
		return {};
	}
}

const COLLECTION_DIRS: Record<EntryType, string> = {
	character: "characters",
	location: "locations",
	object: "objects",
	faction: "factions",
	plot: "plot",
};

function parseStoryMeta(dir: string, issues: PackIssue[]): StoryMeta {
	const path = join(dir, "story.yaml");
	if (!existsSync(path)) return {};
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (err) {
		issues.push({ file: path, message: `story.yaml 读取失败: ${(err as Error).message}` });
		return {};
	}
	try {
		const raw = parseYaml(text);
		const parsed = storyMetaSchema.safeParse(raw ?? {});
		if (!parsed.success) {
			issues.push({ file: path, message: `story.yaml 字段校验失败: ${zodIssueMessage(parsed.error)}` });
			return {};
		}
		return parsed.data;
	} catch (err) {
		issues.push({ file: path, message: `story.yaml 解析失败: ${(err as Error).message}` });
		return {};
	}
}

/** 读 collection 目录树：五类 type 目录下的直接 <id>.yaml 文件（不递归；文件名即条目 id）。 */
function loadCollection(dir: string, issues: PackIssue[]): CollectionEntry[] {
	const collectionRoot = join(dir, "collection");
	if (!existsSync(collectionRoot)) return [];

	// 未知类型目录报错到人（防目录名笔误被静默吞掉）
	const known = new Set(Object.values(COLLECTION_DIRS));
	for (const entry of readdirSync(collectionRoot, { withFileTypes: true })) {
		if (entry.isDirectory() && !known.has(entry.name)) {
			issues.push({
				file: join(collectionRoot, entry.name),
				message: `未知 collection 类型目录: ${entry.name}（应为 characters/locations/objects/factions/plot）`,
			});
		}
	}

	const entries: CollectionEntry[] = [];
	for (const [type, typeDirName] of Object.entries(COLLECTION_DIRS) as Array<[EntryType, string]>) {
		const typeDir = join(collectionRoot, typeDirName);
		if (!existsSync(typeDir)) continue;
		for (const f of readdirSync(typeDir, { withFileTypes: true })) {
			if (!f.isFile() || !f.name.endsWith(".yaml")) continue;
			const id = f.name.slice(0, -".yaml".length);
			const file = join(typeDir, f.name);
			if (!ENTRY_ID_RE.test(id)) {
				issues.push({ file, message: `非法条目 id: ${JSON.stringify(id)}（文件名即条目 id，须匹配 [a-z0-9][a-z0-9_-]*）` });
				continue;
			}
			let raw: unknown;
			try {
				raw = parseYaml(readFileSync(file, "utf-8"));
			} catch (err) {
				issues.push({ file, message: `YAML 解析失败: ${(err as Error).message}` });
				continue;
			}
			const parsed = entrySchema.safeParse(raw ?? {});
			if (!parsed.success) {
				issues.push({ file, message: `条目校验失败: ${zodIssueMessage(parsed.error)}` });
				continue;
			}
			if (parsed.data.type !== type) {
				issues.push({ file, message: `type 与目录不一致: 目录 ${typeDirName}，条目 type=${parsed.data.type}` });
				continue;
			}
			const data = pickSpecialized(parsed.data, type);
			const body = renderEntryBody(type, data);
			entries.push({
				pack: "", // loadPack 成功后回填
				id,
				type,
				name: parsed.data.name,
				keys: parsed.data.keys,
				alwaysOn: parsed.data.always_on,
				position: parsed.data.position,
				refs: parsed.data.refs,
				body,
				summaryLine: buildSummaryLine(parsed.data.name, body),
				data,
			});
		}
	}
	return entries;
}

/** 抽取该类型特化字段为原始对象（不含通用字段）。 */
function pickSpecialized(parsed: ParsedEntry, type: EntryType): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const record = parsed as unknown as Record<string, unknown>;
	for (const field of SPECIALIZED_FIELDS[type]) {
		if (field in record && record[field] !== undefined) {
			out[field] = record[field];
		}
	}
	return out;
}

/** 代码入口收集（只收集不加载）：index.ts 或 pi.extensions 声明。 */
function detectCode(dir: string, pkg: PackageJson): { hasCode: boolean; extensionEntryPaths: string[] } {
	const paths: string[] = [];
	const indexPath = join(dir, "index.ts");
	if (existsSync(indexPath)) paths.push(indexPath);
	const ext = pkg.pi?.extensions;
	if (typeof ext === "string") {
		paths.push(resolve(dir, ext));
	} else if (Array.isArray(ext)) {
		for (const e of ext) {
			if (typeof e === "string") paths.push(resolve(dir, e));
		}
	} else if (ext !== undefined && typeof ext === "object") {
		for (const v of Object.values(ext as Record<string, unknown>)) {
			if (typeof v === "string") paths.push(resolve(dir, v));
		}
	}
	return { hasCode: paths.length > 0, extensionEntryPaths: paths };
}

// ---------------------------------------------------------------------------
// 包内引用完整性 + 命名空间前缀静态扫描
// ---------------------------------------------------------------------------

/** 条目文件定位（供 PackLoadError 报错到人）。 */
function entryFilePath(dir: string, entry: { type: EntryType; id: string }): string {
	return join(dir, "collection", COLLECTION_DIRS[entry.type], `${entry.id}.yaml`);
}

/** 包内引用完整性：id 跨 type 唯一 + refs（含 faction.members）断链 + location.parent 断链。 */
function validateInPackRefs(dir: string, packName: string, entries: CollectionEntry[], issues: PackIssue[]): void {
	const byId = new Map<string, CollectionEntry>();
	for (const entry of entries) {
		const prev = byId.get(entry.id);
		if (prev !== undefined) {
			issues.push({
				file: entryFilePath(dir, entry),
				message: `条目 id 冲突: ${JSON.stringify(entry.id)} 已存在于 ${prev.type}/${prev.id}（包内 id 跨 type 唯一）`,
			});
		}
		byId.set(entry.id, entry);
	}
	for (const entry of entries) {
		const file = entryFilePath(dir, entry);
		for (const ref of entryRefs(entry)) {
			const parsed = parseRef(ref);
			if (!parsed.ok) {
				issues.push({ file, message: `引用格式非法: ${JSON.stringify(ref)}（${parsed.message}）` });
				continue;
			}
			if (parsed.pack !== "" && parsed.pack !== packName) continue; // 跨包引用 → loadPacks 校验
			const target = byId.get(parsed.id);
			if (target === undefined || target.type !== parsed.type) {
				issues.push({ file, message: `断链: 包内引用 ${ref} 不存在` });
			}
		}
		if (entry.type === "location") {
			const parent = typeof entry.data.parent === "string" ? entry.data.parent : undefined;
			if (parent !== undefined) {
				if (!ENTRY_ID_RE.test(parent)) {
					issues.push({ file, message: `location.parent 非法条目 id: ${JSON.stringify(parent)}` });
				} else {
					const target = byId.get(parent);
					if (target === undefined || target.type !== "location") {
						issues.push({
							file,
							message: `location.parent 断链: ${JSON.stringify(parent)} 不是本包的 location 条目`,
						});
					}
				}
			}
		}
	}
}

/**
 * 内核保留表白名单（§4.1 卡包 SQL 静态扫描豁免名单）。卡包 SQL 不应写这些表——
 * 写了也报错（表归属内核，多包/内核语义由 core 管理）。
 */
export const KERNEL_TABLE_WHITELIST: readonly string[] = [
	"clock",
	"time_log",
	"events",
	"locations",
	"location_log",
	"phases",
	"world_state",
	"npcs",
	"npc_traits",
	"npc_memories",
	"npc_relations",
	"turn_log",
	"data_status",
	"directives",
	"schema_migrations",
];

const SQL_IDENT = `[A-Za-z_][A-Za-z0-9_]*|"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]`;
const CREATE_TABLE_RE = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENT})`, "gi");
const INSERT_INTO_RE = new RegExp(`INSERT\\s+INTO\\s+(${SQL_IDENT})`, "gi");

/** 去 SQL 标识符引号（"name" / `name` / [name]）。 */
function stripSqlIdent(raw: string): string {
	return raw.replace(/^["`\[]|["`\]]$/g, "");
}

/** 静态扫描 db/schema.sql + db/seed.sql 文本：表名须 `<包名>_` 前缀；写内核表即报错。 */
function scanSqlNamespace(dir: string, packName: string, issues: PackIssue[]): void {
	const files: Array<{ path: string; required: boolean }> = [
		{ path: join(dir, "db", "schema.sql"), required: true },
		{ path: join(dir, "db", "seed.sql"), required: false },
	];
	for (const { path, required } of files) {
		if (!existsSync(path)) {
			if (required) issues.push({ file: path, message: "db/schema.sql 缺失（世界包布局必填；内容可为空）" });
			continue;
		}
		let sql: string;
		try {
			sql = readFileSync(path, "utf-8");
		} catch (err) {
			issues.push({ file: path, message: `读取失败: ${(err as Error).message}` });
			continue;
		}
		const tables = new Set<string>();
		for (const m of sql.matchAll(CREATE_TABLE_RE)) tables.add(stripSqlIdent(m[1]!));
		for (const m of sql.matchAll(INSERT_INTO_RE)) tables.add(stripSqlIdent(m[1]!));
		for (const table of tables) {
			if (KERNEL_TABLE_WHITELIST.includes(table)) {
				issues.push({ file: path, message: `卡包 SQL 不应写内核保留表: ${table}` });
				continue;
			}
			if (!table.startsWith(`${packName}_`)) {
				issues.push({
					file: path,
					message: `命名空间前缀违规: 表名 ${JSON.stringify(table)} 须以 ${packName}_ 开头（多包共存防冲突）`,
				});
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 加载单个世界包（失败抛 PackLoadError，含全部问题）。 */
export function loadPack(dir: string): WorldPack {
	const issues: PackIssue[] = [];
	const resolvedDir = resolve(dir);

	const pkg = readPackageJson(resolvedDir, issues);
	let name: string | null = null;
	if (typeof pkg.name !== "string" || pkg.name.length === 0) {
		issues.push({ file: join(resolvedDir, "package.json"), message: "package.json 缺少 name（世界包名 = package.json name）" });
	} else if (!PACK_NAME_RE.test(pkg.name)) {
		issues.push({
			file: join(resolvedDir, "package.json"),
			message: `非法包名: ${JSON.stringify(pkg.name)}（须匹配 [a-z][a-z0-9_]*，直接作 SQL 前缀不转换）`,
		});
	} else {
		name = pkg.name;
	}

	const story = parseStoryMeta(resolvedDir, issues);
	const entries = loadCollection(resolvedDir, issues);
	const { hasCode, extensionEntryPaths } = detectCode(resolvedDir, pkg);

	if (name !== null) {
		for (const entry of entries) entry.pack = name;
		validateInPackRefs(resolvedDir, name, entries, issues);
		scanSqlNamespace(resolvedDir, name, issues);
	}

	if (issues.length > 0) throw new PackLoadError(issues);
	return { name: name!, dir: resolvedDir, story, entries, hasCode, extensionEntryPaths };
}

/** 跨包条目索引：包名 → (type:id → entry)。 */
type EntryIndex = Map<string, Map<string, CollectionEntry>>;

function buildEntryIndex(packs: WorldPack[]): EntryIndex {
	const index: EntryIndex = new Map();
	for (const pack of packs) {
		const byRef = new Map<string, CollectionEntry>();
		for (const entry of pack.entries) byRef.set(`${entry.type}:${entry.id}`, entry);
		index.set(pack.name, byRef);
	}
	return index;
}

/**
 * 加载多个世界包并做跨包校验：每包自身的 PackLoadError 问题收集合并 + 包名唯一 +
 * 跨包引用断链（`包名:type:id`），一次抛出全部问题。
 */
export function loadPacks(dirs: string[]): WorldPack[] {
	const issues: PackIssue[] = [];
	const packs: WorldPack[] = [];
	for (const dir of dirs) {
		try {
			packs.push(loadPack(dir));
		} catch (err) {
			if (err instanceof PackLoadError) {
				issues.push(...err.issues);
			} else {
				issues.push({ message: `加载卡包失败 ${dir}: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
	}

	// 包名唯一（命名空间 = 包名；多包共存同名冲突）
	const seenNames = new Set<string>();
	for (const pack of packs) {
		if (seenNames.has(pack.name)) {
			issues.push({ message: `重复的卡包名: ${pack.name}（多包共存时包名即命名空间，须唯一）` });
		}
		seenNames.add(pack.name);
	}

	// 跨包引用完整性（包内引用已在 loadPack 校验）
	const index = buildEntryIndex(packs);
	for (const pack of packs) {
		for (const entry of pack.entries) {
			const file = entryFilePath(pack.dir, entry);
			for (const ref of entryRefs(entry)) {
				const parsed = parseRef(ref);
				if (!parsed.ok) continue; // 格式问题已在 loadPack 报
				if (parsed.pack === "" || parsed.pack === pack.name) continue;
				if (!index.get(parsed.pack)?.has(`${parsed.type}:${parsed.id}`)) {
					issues.push({ file, message: `断链: 跨包引用 ${ref} 不存在` });
				}
			}
		}
	}

	if (issues.length > 0) throw new PackLoadError(issues);
	return packs;
}
