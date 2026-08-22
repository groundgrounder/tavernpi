// M5 故事驱动集成验收（创作规划 §4.0 / §7-M5）：卡包系统自断言脚本。
//
// 六区：
// A. 加载与校验（确定性，临时目录现建坏包）：断链 refs（包内/跨包）/ zod strict unknown 字段 /
//    命名空间前缀违规 / 内核保留表写入 / 多包同名 id 共存 + 跨包引用解析。
// B. seed 与 schema（确定性，createStory 到临时 storiesRoot）：npcs card_ref / locations parent /
//    卡包自建表与 seed / 迁移幂等重跑 / story.meta.json。
// C. story.yaml 消费（确定性）：clock 历法粒度 / 开场白首轮（turn_log 0 + session 根 assistant +
//    初始快照）/ stylize styleHint 缺省读 story.meta.json defaultStyle（桩 executor 断言）。
// D. 检索式注入证据（真实 LLM，2 轮）：onSystemPromptRender 断言常驻/触发/钉三通道注入 +
//    refs 摘要行；TurnResult.collection.injected；正文宽松匹配注入要素。
// E. packages/tools 校验 CLI 冒烟（子进程）：好包 exit 0 / 坏包 exit 1 含文件名 / init 骨架过检。
// F. m5-cli 管道冒烟（子进程，真实 LLM 1 轮）：/packs + 一轮叙事 + /status。
//
// 成本控制：真实 LLM 共 3 轮（D 2 轮 + F 1 轮，npc/story 关闭）。
// provider 故障（402 等）与断言失败明确区分：[PROVIDER] 标记打印，断言 FAIL 仍计入。
// 运行：npm run m5:accept（或 node packages/app/acceptance/m5.ts）。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
	PackCache,
	PackLoadError,
	createPipelineEventLog,
	createStory,
	createStoryRuntime,
	loadPacks,
	migrate,
	openSnapshotsDb,
	openStoryDb,
	packMigrations,
	snapshotsDbPath,
	storyDbPath,
	type PipelineEvent,
	type StoryMetaFile,
	type StoryState,
	type SubagentResult,
	type SubagentRunOptions,
	type SubagentUsage,
} from "@tavernpi/core";

const repoRoot = resolve(import.meta.dirname, "../../..");
const SHOULING = join(repoRoot, "packages/app/acceptance/fixtures/shouling");
const MINIPACK = join(repoRoot, "packages/app/acceptance/fixtures/minipack");
const ZERO_USAGE: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };

// ---------------------------------------------------------------------------
// 检查表（沿 m4）
// ---------------------------------------------------------------------------

interface Check {
	label: string;
	ok: boolean;
}

function check(label: string, ok: boolean): Check {
	return { label, ok };
}

function printChecks(checks: Check[]): void {
	let failed = 0;
	for (const c of checks) {
		console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.label}`);
		if (!c.ok) failed++;
	}
	const passCount = checks.length - failed;
	console.log(`===== M5 验收: ${failed === 0 ? "PASS" : "FAIL"}（${passCount}/${checks.length} 通过） =====`);
	if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function stubResult(output: unknown): SubagentResult<unknown> {
	return { output, usage: ZERO_USAGE, durationMs: 1 };
}

/** 在 root 下写文件（自动建父目录）。 */
function writeFile(root: string, rel: string, content: string): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** 最小合法包（可覆盖 entries/sql）。 */
function writePack(
	root: string,
	name: string,
	opts: { entries?: Array<{ type: string; id: string; yaml: string }>; schemaSql?: string } = {},
): string {
	const dir = join(root, name);
	writeFile(dir, "package.json", `${JSON.stringify({ name, version: "0.0.0" }, null, 2)}\n`);
	writeFile(dir, "db/schema.sql", opts.schemaSql ?? "");
	for (const e of opts.entries ?? []) writeFile(dir, `collection/${e.type}/${e.id}.yaml`, e.yaml);
	return dir;
}

const CHAR = (name: string, extra = ""): string =>
	`type: character\nname: ${name}\nidentity: 身份\npersonality: 性格\n${extra}`;

/** 判定错误是否疑似 provider 故障（余额/限流/网络），用于与验收断言失败区分。 */
function isProviderError(err: unknown): boolean {
	const text = String(err instanceof Error ? err.message : err);
	return /402|insufficient|balance|quota|rate.?limit|ECONN|ETIMEDOUT|fetch failed/i.test(text);
}

/** 子进程跑 CLI（stdin 喂 input，超时保护）。 */
function runCli(
	script: string,
	args: string[],
	opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(process.execPath, [script, ...args], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			done({ code: -1, stdout, stderr: `${stderr}\n[timeout] 冒烟超时被杀` });
		}, opts.timeoutMs ?? 120_000);
		child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? -1, stdout, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			done({ code: -1, stdout, stderr: `${stderr}\n${String(err)}` });
		});
		if (opts.stdin !== undefined) {
			child.stdin.write(opts.stdin);
		}
		child.stdin.end();
	});
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "tavernpi-m5-accept-"));
	const checks: Check[] = [];
	try {
		// ================= A. 加载与校验（确定性） =================
		console.log("\n===== A. 加载与校验（坏包报错到人） =====");
		const aRoot = join(root, "a");
		mkdirSync(aRoot, { recursive: true });

		// A.1 包内断链 refs
		writePack(aRoot, "broken_in", {
			entries: [{ type: "characters", id: "a", yaml: CHAR("甲", "refs: [location:nowhere]\n") }],
		});
		const a1 = capturePackError(() => loadPacks([join(aRoot, "broken_in")]));
		checks.push(
			check(
				`A1: 包内断链 → PackLoadError 且 issue 含文件名（${a1?.issues[0]?.file ?? "?"}）`,
				a1 !== null && a1.issues.length > 0 && (a1.issues[0]?.file ?? "").includes("a.yaml"),
			),
		);

		// A.2 跨包断链 refs
		writePack(aRoot, "ref_out", {
			entries: [{ type: "characters", id: "a", yaml: CHAR("甲", "refs: [target_pack:character:ghost]\n") }],
		});
		writePack(aRoot, "target_pack", {
			entries: [{ type: "characters", id: "b", yaml: CHAR("乙") }],
		});
		const a2 = capturePackError(() => loadPacks([join(aRoot, "ref_out"), join(aRoot, "target_pack")]));
		checks.push(check("A2: 跨包断链 → PackLoadError", a2 !== null && a2.issues.length > 0));

		// A.3 zod strict unknown 字段
		writePack(aRoot, "strict_pack", {
			entries: [{ type: "characters", id: "a", yaml: CHAR("甲", "bogus_field: 笔误\n") }],
		});
		const a3 = capturePackError(() => loadPacks([join(aRoot, "strict_pack")]));
		checks.push(check("A3: unknown 字段（bogus_field）→ PackLoadError", a3 !== null && a3.issues.length > 0));

		// A.4 命名空间前缀违规
		writePack(aRoot, "bad_prefix", { schemaSql: "CREATE TABLE IF NOT EXISTS no_prefix_table (id INTEGER);\n" });
		const a4 = capturePackError(() => loadPacks([join(aRoot, "bad_prefix")]));
		checks.push(check("A4: 无前缀表（no_prefix_table）→ PackLoadError", a4 !== null && a4.issues.length > 0));

		// A.5 内核保留表写入
		writePack(aRoot, "kernel_write", { schemaSql: "INSERT INTO npcs (name) VALUES ('越权');\n" });
		const a5 = capturePackError(() => loadPacks([join(aRoot, "kernel_write")]));
		checks.push(check("A5: 卡包 SQL 写内核表（npcs）→ PackLoadError", a5 !== null && a5.issues.length > 0));

		// A.6 多包同名 id 共存 + 跨包引用解析
		writePack(aRoot, "pack_x", {
			entries: [{ type: "characters", id: "hero", yaml: CHAR("X主角") }],
		});
		writePack(aRoot, "pack_y", {
			entries: [{ type: "characters", id: "hero", yaml: CHAR("Y主角", "refs: [pack_x:character:hero]\n") }],
		});
		const a6 = ((): { ok: boolean; note: string } => {
			try {
				const packs = loadPacks([join(aRoot, "pack_x"), join(aRoot, "pack_y")]);
				const names = packs.flatMap((p) => p.entries.map((e) => `${e.pack}:${e.id}`));
				return { ok: names.includes("pack_x:hero") && names.includes("pack_y:hero"), note: names.join(",") };
			} catch (err) {
				return { ok: false, note: String(err) };
			}
		})();
		checks.push(check(`A6: 多包同名 id 共存 + 跨包引用解析（${a6.note}）`, a6.ok));

		// ================= B. seed 与 schema（确定性） =================
		console.log("\n===== B. createStory：seed 与卡包 schema 落库 =====");
		const bRoot = join(root, "b");
		const bStory = await createStory({ storiesRoot: bRoot, packDirs: [SHOULING, MINIPACK], cwd: bRoot });
		const bDb = bStory.storyState.storyDb;
		const bNpcs = bDb.reader.listNpcs();
		const bLocations = bDb.reader.listLocations();
		checks.push(
			check(
				`B1: npcs 3 行 card_ref 正确（${bNpcs.map((n) => n.card_ref).join(", ")}）`,
				bNpcs.length === 3 &&
					bNpcs.some((n) => n.card_ref === "shouling:shen-qiu") &&
					bNpcs.some((n) => n.card_ref === "shouling:wu-zhuo") &&
					bNpcs.some((n) => n.card_ref === "minipack:a-qing"),
			),
		);
		const bPassage = bLocations.find((l) => l.name === "墓道");
		const bTomb = bLocations.find((l) => l.name === "王陵");
		checks.push(
			check(
				`B2: locations 3 行且墓道 parent=王陵（${bLocations.map((l) => l.name).join(", ")}）`,
				bLocations.length === 3 && bPassage !== undefined && bTomb !== undefined && bPassage.parent_id === bTomb.id,
			),
		);
		const bFavor = bDb.rawDb.prepare("SELECT npc_ref, favor FROM shouling_favor").all() as Array<{ npc_ref: string; favor: number }>;
		checks.push(
			check(
				`B3: shouling_favor seed 1 行（${JSON.stringify(bFavor)}）`,
				bFavor.length === 1 && bFavor[0]!.npc_ref === "shouling:shen-qiu" && bFavor[0]!.favor === 0,
			),
		);
		bDb.rawDb.prepare("SELECT * FROM minipack_tokens").all();
		checks.push(check("B4: minipack_tokens 表存在（查询不炸）", true));
		// 迁移幂等：重跑 packMigrations 无新迁移
		const bPacks = loadPacks([SHOULING, MINIPACK]);
		let bReapply: string[] = [];
		for (const m of packMigrations(bPacks)) {
			bReapply = bReapply.concat(migrate(bDb.rawDb, [m]));
		}
		checks.push(check(`B5: 迁移幂等重跑（重跑 applied=${JSON.stringify(bReapply)}）`, bReapply.length === 0));
		const bMeta = JSON.parse(readFileSync(join(bStory.storyDir, "story.meta.json"), "utf8")) as StoryMetaFile;
		checks.push(
			check(
				`B6: story.meta.json（title=${bMeta.title} packs=${bMeta.packs.map((p) => p.name).join(",")}）`,
				bMeta.title === "守陵人" && bMeta.packs.length === 2 && bMeta.defaultStyle !== undefined,
			),
		);
		const bDbPath = bDb.path;
		bDb.close();
		bStory.storyState.snapshotsDb.close();
		// 重开幂等：seed 不重复
		const bReopen = openStoryDb(bDbPath);
		checks.push(
			check(
				`B7: 重开故事库 seed 不重复（npcs=${bReopen.reader.listNpcs().length}）`,
				bReopen.reader.listNpcs().length === 3,
			),
		);
		bReopen.close();

		// ================= C. story.yaml 消费（确定性） =================
		console.log("\n===== C. story.yaml 消费 =====");
		const cRoot = join(root, "c");
		const cStory = await createStory({ storiesRoot: cRoot, packDirs: [SHOULING], cwd: cRoot });
		const cDb = cStory.storyState.storyDb;
		const cClock = cDb.reader.getClock();
		checks.push(
			check(
				`C1: clock 历法/粒度 = 大雍历/elastic（实际 ${cClock?.calendar}/${cClock?.granularity}）`,
				cClock?.calendar === "大雍历" && cClock?.granularity === "elastic",
			),
		);
		const cTurns = cDb.reader.getTurnLog();
		const cMessages = cStory.sessionManager
			.getEntries()
			.filter((e) => e.type === "message") as Array<{ id: string; parentId: string | null; message: { role: string; content?: unknown } }>;
		const cSnaps = cStory.storyState.snapshotsDb.listSnapshots();
		checks.push(
			check(
				`C2: 开场白首轮（turn_log 0 + session 根 assistant + 初始快照）`,
				cTurns.length === 1 &&
					cTurns[0]!.turn_seq === 0 &&
					cMessages.length === 1 &&
					cMessages[0]!.message.role === "assistant" &&
					cMessages[0]!.parentId === null &&
					cSnaps.length === 1 &&
					cSnaps[0]!.session_entry_id === cMessages[0]!.id,
			),
		);
		cDb.close();
		cStory.storyState.snapshotsDb.close();

		// ================= D. 检索式注入证据（真实 LLM，2 轮） =================
		console.log("\n===== D. 检索式注入证据（真实 LLM） =====");
		const dRoot = join(root, "d");
		const dStory = await createStory({ storiesRoot: dRoot, packDirs: [SHOULING, MINIPACK], cwd: dRoot });
		const dEventLog = createPipelineEventLog();
		const dEvents: PipelineEvent[] = [];
		dEventLog.on((e) => dEvents.push(e));
		const dSystemPrompts: string[] = [];
		const dWarnings: string[] = [];
		const dPinned: string[] = [];
		// stylize 桩 executor：捕获系统提示（C3 styleHint 断言）+ 原文不动返回（factCheck 恒过）
		let dStylizePrompt = "";
		const dStylizeExecutor = async (opts: SubagentRunOptions): Promise<SubagentResult<unknown>> => {
			dStylizePrompt = opts.systemPrompt;
			const m = /## 待润色原文（不得改变任何事实）\n([\s\S]*?)\n\n## 指令/.exec(opts.userPrompt);
			return stubResult({ text: m?.[1] ?? "（未提取到原文）" });
		};
		const dRuntime = await createStoryRuntime({
			cwd: dRoot,
			sessionManager: dStory.sessionManager,
			storyState: dStory.storyState,
			eventLog: dEventLog,
			packs: { cache: new PackCache([SHOULING, MINIPACK]), pinned: () => dPinned },
			stylize: { enabled: true, executor: dStylizeExecutor },
			onWarning: (m) => dWarnings.push(m),
			onSystemPromptRender: (rendered) => dSystemPrompts.push(rendered),
		});
		try {
			// D 第 1 轮：keys 触发「墓道」+ always_on 常驻「王陵」
			const d1 = await dRuntime.runTurn("我握紧铜钥，独自走向漆黑的墓道深处。");
			const dPrompt1 = dSystemPrompts.at(-1) ?? "";
			console.log(`[obs] D1: injected=${JSON.stringify(d1.collection?.injected)} warnings=${JSON.stringify(d1.collection?.warnings)}`);
			console.log(`[obs] D1: narrative(${d1.narrativeText.length}字): ${d1.narrativeText.slice(0, 120)}`);
			checks.push(
				check(
					"D1: 系统提示含常驻条目（王陵/always_on）正文",
					dPrompt1.includes("王陵") && dPrompt1.includes("世界设定"),
				),
			);
			checks.push(check("D1: 系统提示含触发条目（墓道/keys 命中）正文", dPrompt1.includes("墓道")));
			checks.push(
				check(
					`D1: collection.injected 含 shouling:location:tomb-passage（${JSON.stringify(d1.collection?.injected)}）`,
					d1.collection?.injected.includes("shouling:location:tomb-passage") === true,
				),
			);
			checks.push(check(`D1: data.ok=${d1.data.ok} snapshot=${d1.snapshotTaken}`, d1.data.ok));
			const d1Echo = /墓道|王陵|守陵人|沈秋/.test(d1.narrativeText);
			console.log(`[obs] D1: 正文引用注入要素=${d1Echo}`);
			checks.push(check("D1: 主叙事正文引用注入设定要素（墓道/王陵/守陵人 任一）", d1Echo));

			// D 第 2 轮：手动钉沈秋 → refs 摘要行（王陵/旧廷遗党）
			dPinned.push("shouling:character:shen-qiu");
			const d2 = await dRuntime.runTurn("我点亮铜灯，回头望向陵门方向。");
			const dPrompt2 = dSystemPrompts.at(-1) ?? "";
			console.log(`[obs] D2: injected=${JSON.stringify(d2.collection?.injected)}`);
			checks.push(
				check(
					`D2: pinned 注入沈秋（${JSON.stringify(d2.collection?.injected)}）`,
					d2.collection?.injected.includes("shouling:character:shen-qiu") === true && dPrompt2.includes("沈秋"),
				),
			);
			const refsLineOk = dPrompt2.includes("【关联】") && (dPrompt2.includes("旧廷遗党") || dPrompt2.includes("王陵"));
			checks.push(check("D2: refs 一级摘要行展开（【关联】含王陵/旧廷遗党）", refsLineOk));

			// C3（并入 D 轮次省调用）：stylize styleHint 缺省读 story.meta.json defaultStyle
			checks.push(
				check(
					"C3: stylize 桩 executor 系统提示含 story.yaml defaultStyle（文风接线）",
					dStylizePrompt.includes("简洁克制的古典志怪笔法"),
				),
			);
			checks.push(check(`D2: data.ok=${d2.data.ok}`, d2.data.ok));
			// 事件流：pack 角色警告记录机制存在（本轮应无警告）
			checks.push(
				check(
					`D: 本轮无卡包警告（warnings=${JSON.stringify(dWarnings)}）`,
					dWarnings.length === 0,
				),
			);
		} catch (err) {
			if (isProviderError(err)) {
				console.log(`[PROVIDER] D 区真实 LLM 调用失败（疑似 provider 故障，非验收断言）：${String(err)}`);
			}
			throw err;
		} finally {
			dRuntime.dispose();
			dStory.storyState.storyDb.close();
			dStory.storyState.snapshotsDb.close();
		}

		// ================= E. packages/tools 校验 CLI 冒烟（子进程） =================
		console.log("\n===== E. tavernpi-pack CLI 冒烟 =====");
		const toolsCli = join(repoRoot, "packages/tools/src/cli.ts");
		const e1 = await runCli(toolsCli, ["check", SHOULING, MINIPACK], { timeoutMs: 60_000 });
		checks.push(check(`E1: check 好包 exit=0（实际 ${e1.code}）`, e1.code === 0));
		checks.push(check("E1: 输出含条目统计", e1.stdout.includes("条目")));

		const eBadRoot = join(root, "e-bad");
		writePack(eBadRoot, "bad_pack", {
			entries: [{ type: "characters", id: "a", yaml: CHAR("甲", "refs: [location:ghost]\n") }],
		});
		const e2 = await runCli(toolsCli, ["check", join(eBadRoot, "bad_pack")], { timeoutMs: 60_000 });
		checks.push(check(`E2: check 坏包 exit=1（实际 ${e2.code}）`, e2.code === 1));
		checks.push(check("E2: 报错含文件名（a.yaml）", `${e2.stdout}\n${e2.stderr}`.includes("a.yaml")));

		const eInitDir = join(root, "e-init", "new_pack");
		const e3 = await runCli(toolsCli, ["init", eInitDir], { timeoutMs: 60_000 });
		const e4 = e3.code === 0 ? await runCli(toolsCli, ["check", eInitDir], { timeoutMs: 60_000 }) : { code: -1, stdout: "", stderr: "init failed" };
		checks.push(check(`E3: init 生成骨架 exit=0（实际 ${e3.code}）`, e3.code === 0));
		checks.push(check(`E4: init 骨架 check 通过（实际 ${e4.code}）`, e4.code === 0));

		// ================= F. m5-cli 管道冒烟（真实 LLM，1 轮） =================
		console.log("\n===== F. m5-cli 管道冒烟 =====");
		const fRoot = join(root, "cli");
		mkdirSync(fRoot, { recursive: true });
		const f = await runCli(
			join(repoRoot, "packages/app/src/m5-cli.ts"),
			["--root", fRoot, "--pack", SHOULING, "--pack", MINIPACK],
			{ stdin: "/packs\n我环顾四周，打量这座陵寝。\n/status\n\n", timeoutMs: 180_000 },
		);
		console.log(`[obs] F: exit=${f.code}`);
		if (f.code !== 0) console.log(`[obs] F stderr: ${f.stderr.slice(0, 400)}`);
		if (isProviderError(f.stderr) || isProviderError(f.stdout)) {
			console.log("[PROVIDER] F 区疑似 provider 故障（非验收断言）");
		}
		checks.push(check("F1: m5-cli 冒烟 exit=0", f.code === 0));
		checks.push(check("F1: /packs 输出含两包", f.stdout.includes("shouling") && f.stdout.includes("minipack")));
		checks.push(check("F1: 一轮叙事正文产出（第 1 轮）", f.stdout.includes("第 1 轮")));
		checks.push(check("F1: /status 含大雍历", f.stdout.includes("大雍历")));

		console.log("\n===== M5 验收检查表 =====");
		printChecks(checks);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** 捕获 PackLoadError（非 PackLoadError 的异常直接上抛）。 */
function capturePackError(fn: () => unknown): PackLoadError | null {
	try {
		fn();
		return null;
	} catch (err) {
		if (err instanceof PackLoadError) return err;
		throw err;
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
