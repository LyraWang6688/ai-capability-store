/**
 * 数据目录解析。
 *
 * ## 为什么需要单独一个模块
 *
 * 原来是 `join(ROOT, '.out')` / `join(ROOT, '.state')`，`ROOT` 是**包目录**。
 * 本地开发时没问题（包目录就是 git 仓库，两个目录都在 `.gitignore` 里）。
 *
 * 但**全局 npm 安装时 `ROOT` 是 `node_modules/teaming-mcp`**——
 * 往那里写运行数据有两个问题：
 *   1. 可能没有写权限（尤其是 `sudo npm i -g`，目录属 root）
 *   2. 升级/重装会被清掉，报告和任务账本全丢
 *
 * 所以按「是不是 git 检出」分流：
 *
 * | 场景 | 数据目录 | 理由 |
 * |---|---|---|
 * | git 检出（开发） | `<仓库>/.out`、`<仓库>/.state` | 沿用旧行为，两个目录已在 .gitignore |
 * | npm 安装（分发） | `~/.teaming-mcp/` | 用户可写、升级不丢、天然在仓库外 |
 *
 * 两者都可被环境变量覆盖：`TEAMING_OUT`、`TEAMING_STATE`、`TEAMING_JOBS`。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(HERE, '..');

/** 是不是从 git 检出直接运行（开发/自用），而不是 npm 安装的包 */
export function isGitCheckout() {
  return existsSync(join(PACKAGE_ROOT, '.git'));
}

function dataRoot() {
  return process.env.TEAMING_DATA_DIR
    || (isGitCheckout() ? PACKAGE_ROOT : join(homedir(), '.teaming-mcp'));
}

/** 报告与逐字稿落盘目录 */
export function resolveOutDir() {
  return process.env.TEAMING_OUT || join(dataRoot(), '.out');
}

/** 账本、任务记录等运行态数据 */
export function resolveStateDir() {
  return process.env.TEAMING_STATE || join(dataRoot(), '.state');
}

/** 分析任务记录目录 */
export function resolveJobsDir() {
  return process.env.TEAMING_JOBS || join(resolveStateDir(), 'jobs');
}
