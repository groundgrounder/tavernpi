// M0 spike #6：SQLite backup 往返（写库 → 快照 → 改库 → 恢复 → 断言一致）。
//
// 补录工件：该项在 M0 前已手工实证（技术路线 §4 第 6 行），本脚本把它固化为可复现的自断言工件
// （M0 收口评审 M1 项补救）。它是 §3.1 ★承重快照机制（snapshots.db + 原子恢复）的底层 API 验证。
//
// 验证点：
// 1. node:sqlite 模块级 backup(db, path) 生成一致快照（快照时刻的状态被冻结）；
// 2. 快照后继续写库不影响快照文件；
// 3. 恢复 = 关闭连接 → 原子替换（先写临时文件再 rename）→ 重连，数据回到快照时刻；
// 4. 全程自断言，失败 exit 1。

import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function assert(cond: boolean, msg: string): void {
	if (!cond) {
		console.error(`FAIL: ${msg}`);
		process.exit(1);
	}
	console.log(`PASS: ${msg}`);
}

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "tavernpi-spike06-"));
	const dbPath = join(dir, "story.db");
	const snapPath = join(dir, "snap.db");
	try {
		// 1. 写库：快照前状态 = 单行 turn=1
		const db = new DatabaseSync(dbPath);
		db.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
		db.prepare("INSERT INTO meta (k, v) VALUES ('turn', '1')").run();

		// 2. 快照（模块级 backup API）
		await backup(db, snapPath);
		assert(existsSync(snapPath), "backup(db, path) 生成快照文件");

		// 3. 改库：快照后写入 turn=2
		db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('turn', '2')").run();
		const afterWrite = db.prepare("SELECT v FROM meta WHERE k = 'turn'").get() as { v: string };
		assert(afterWrite.v === "2", "改库生效（turn=2）");

		// 快照文件不受后续写入影响（独立连接读快照验证）
		const snapDb = new DatabaseSync(snapPath, { readOnly: true });
		const snapRow = snapDb.prepare("SELECT v FROM meta WHERE k = 'turn'").get() as { v: string };
		snapDb.close();
		assert(snapRow.v === "1", "快照冻结在快照时刻（turn=1），不受后续写入影响");

		// 4. 恢复：关闭连接 → 原子替换（临时文件 + rename）→ 重连
		db.close();
		const tmpPath = join(dir, "restore.tmp");
		copyFileSync(snapPath, tmpPath);
		renameSync(tmpPath, dbPath); // 原子替换
		const restored = new DatabaseSync(dbPath);
		const restoredRow = restored.prepare("SELECT v FROM meta WHERE k = 'turn'").get() as { v: string };
		restored.close();
		assert(restoredRow.v === "1", "原子恢复后数据回到快照时刻（turn=1）");

		console.log("\n===== spike #6: PASS（backup 往返全部断言通过） =====");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
	process.exitCode = 1;
});
