// 测试共享工具：临时目录生命周期。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 创建临时目录（测试后须调用 cleanupTempDir 删除）。 */
export function makeTempDir(prefix = "tavernpi-core-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** 递归删除临时目录（force 保证不存在也安全）。 */
export function cleanupTempDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}
