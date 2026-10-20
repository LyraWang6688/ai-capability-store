/**
 * 破坏性操作的防护层（0.3.0 起）。
 *
 * 本项目对"写外部世界"的默认边界是：**只创建草稿**（不发布、不群发、不删除）。
 * 0.3.0 按使用方要求开放三类破坏性操作，但每一类都必须同时过四道门：
 *
 *   ① 显式开关：WECHAT_ALLOW_DESTRUCTIVE=1，**默认关闭** —— 宿主必须刻意打开，
 *      避免任何一次误调用（或提示词注入）就能删掉线上内容。
 *   ② 目标确认：confirm 必须等于目标 ID 的后 6 位 —— 强制调用方真正"看过"目标。
 *   ③ 先备份：把删除对象的当前内容落盘到 state/backups/，删掉也能重建。
 *   ④ 审计留痕：state/audit.jsonl 记录时间、操作、目标、结果、备份路径。
 *
 * 其中 `draft/update` 不改变"存在性"，因此不受①②约束，但**仍必须先备份**，
 * 因为它会覆盖用户可能手工编辑过的正文。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateDir } from "./deliveryState.js";

export type DestructiveOperation =
  | "draft/update"
  | "draft/delete"
  | "material/del_material"
  | "freepublish/delete";

export class DestructiveOperationBlockedError extends Error {
  readonly code = "DESTRUCTIVE_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "DestructiveOperationBlockedError";
  }
}

/** 默认关闭；只有宿主显式注入 WECHAT_ALLOW_DESTRUCTIVE=1 才放行。 */
export function isDestructiveAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WECHAT_ALLOW_DESTRUCTIVE?.trim() === "1";
}

export function assertDestructiveAllowed(
  operation: DestructiveOperation,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (isDestructiveAllowed(env)) return;
  throw new DestructiveOperationBlockedError(
    `「${operation}」会改动或删除公众号里已有的内容，属于破坏性操作，当前默认关闭。` +
      `确认要开放时，请在连接器/宿主配置里显式注入环境变量 WECHAT_ALLOW_DESTRUCTIVE=1 后重试。` +
      `执行前我们会先自动备份目标内容到本地（state/backups/），并把本次操作写入审计日志。`
  );
}

/** 目标确认令牌 = 目标 ID 的后 6 位（不足 6 位则取全量）。 */
export function confirmationTokenFor(targetId: string): string {
  const clean = (targetId ?? "").trim();
  return clean.length <= 6 ? clean : clean.slice(-6);
}

export function assertConfirmed(
  operation: DestructiveOperation,
  targetId: string,
  confirm: string | undefined
): void {
  const expected = confirmationTokenFor(targetId);
  if (expected && (confirm ?? "").trim() === expected) return;
    // Neither the expected value nor the target ID is echoed.
    //
    // The old message printed `（目标 X → 应为 Y）`, so one failed call returned the answer
    // and the retry passed — a "prove you looked at the target" gate reduced to a "call
    // twice" gate. The first attempt at fixing that stopped printing the expected value
    // but kept printing the target ID ... which is the same leak, because the token *is*
    // the last six characters of the target ID. A test caught it. Both are gone now.
    //
    // Be clear about what this gate is worth: the caller supplies `targetId`, so it can
    // always derive the token itself. The gate is not a secret; it is a **stop-and-look**
    // step. Removing the echo only means the caller has to stop and derive it instead of
    // copy-pasting it out of an error.
  throw new DestructiveOperationBlockedError(
    `「${operation}」需要二次确认：请把目标 ID 的后 6 位作为 confirm 传入。\n` +
      `目标 ID 不回显 —— 它是你传进来的，你手上就有它；而它的后 6 位就是期望值，\n` +
      `所以回显目标 ID 等于把答案交出去。\n` +
      `请先去读目标的 ID（例如用 get_wechat_draft 或后台草稿箱），算出后 6 位再传进来。`
  );
}

export type BackupResult = { path: string; bytes: number };

/** 把目标当前内容落盘备份（默认 state/backups/）。 */
export async function writeBackup(input: {
  kind: string;
  targetId: string;
  payload: unknown;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<BackupResult> {
  const dir = path.join(stateDir(input.env ?? process.env), "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const safe = (input.targetId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const file = path.join(dir, `${input.kind}-${safe}-${stamp}.json`);
  const text = JSON.stringify(input.payload, null, 2);
  await writeFile(file, text, { mode: 0o600 });
  return { path: file, bytes: Buffer.byteLength(text) };
}

export type AuditRecord = {
  at: string;
  operation: DestructiveOperation;
  targetId: string;
  outcome: "ok" | "failed" | "dry-run";
  backupPath?: string;
  detail?: string;
};

/** 追加一行审计记录（jsonl），返回文件路径。 */
export async function appendAudit(
  record: Omit<AuditRecord, "at"> & { at?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const { at, ...rest } = record;
  const dir = stateDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "audit.jsonl");
  await appendFile(file, `${JSON.stringify({ at: at ?? new Date().toISOString(), ...rest })}\n`, { mode: 0o600 });
  return file;
}

export async function readAudit(limit = 20, env: NodeJS.ProcessEnv = process.env): Promise<AuditRecord[]> {
  const file = path.join(stateDir(env), "audit.jsonl");
  try {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => JSON.parse(line) as AuditRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
