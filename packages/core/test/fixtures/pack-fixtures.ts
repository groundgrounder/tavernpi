// 卡包测试 fixture 构造（临时目录现建，参考 helpers.makeTempDir）。
// 每个测试用 createPack 在临时目录下生成完整卡包布局，测试后 cleanupTempDir。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { cleanupTempDir, makeTempDir } from "../helpers.ts";

export { cleanupTempDir, makeTempDir };

/** 在 root 下写文件（自动建父目录），返回绝对路径。 */
export function writeFile(root: string, rel: string, content: string): string {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

/** 条目 YAML 序列化（yaml 包 stringify，多行文本自动 block 样式）。 */
export function entryYaml(obj: Record<string, unknown>): string {
	return stringifyYaml(obj);
}

export interface PackFixtureOptions {
	name?: string;
	/** story.yaml 内容；缺省不写 story.yaml（= 空 StoryMeta）。 */
	story?: string;
	entries?: Array<{ type: string; id: string; yaml: string }>;
	/** 缺省写空 schema.sql（布局必填，内容可为空）。传 null 表示不写该文件。 */
	schemaSql?: string | null;
	/** 缺省不写 seed.sql（可选）。 */
	seedSql?: string;
	hasIndexTs?: boolean;
	/** pi.extensions 声明（package.json pi 字段）。 */
	piExtensions?: string | string[];
}

/** 在 root 下构造一个完整卡包目录，返回包目录（绝对路径）。 */
export function createPack(root: string, opts: PackFixtureOptions): string {
	const name = opts.name ?? "my_world";
	const dir = join(root, name);
	const pkg: Record<string, unknown> = { name, version: "0.0.0" };
	if (opts.piExtensions !== undefined) {
		pkg.pi = { extensions: opts.piExtensions };
	}
	writeFile(dir, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
	if (opts.story !== undefined) writeFile(dir, "story.yaml", opts.story);
	for (const entry of opts.entries ?? []) {
		writeFile(dir, `collection/${entry.type}/${entry.id}.yaml`, entry.yaml);
	}
	if (opts.schemaSql !== null) {
		writeFile(dir, "db/schema.sql", opts.schemaSql ?? "");
	}
	if (opts.seedSql !== undefined) writeFile(dir, "db/seed.sql", opts.seedSql);
	if (opts.hasIndexTs === true) writeFile(dir, "index.ts", "export default () => {};\n");
	return dir;
}

/** 最小 character 条目 YAML（仅必填特化字段）。 */
export function characterEntry(name: string, extra: Record<string, unknown> = {}): string {
	return entryYaml({ type: "character", name, identity: "身份", personality: "性格", ...extra });
}

/** 最小 location 条目 YAML（仅必填特化字段）。 */
export function locationEntry(name: string, extra: Record<string, unknown> = {}): string {
	return entryYaml({ type: "location", name, overview: "概述", features: [], ...extra });
}
