/**
 * 投递状态（幂等账本）。
 *
 * 语义与 Publisher 通道一致，但实现独立、文件独立 —— 两个通道的幂等键空间不同，
 * 混在一个文件里会造成 Failure Domain 合并（一条坏记录让另一条链整体拒绝服务）。
 *
 * 状态机：
 *   (无) ──reserve──▶ creating ──成功──▶ created
 *                        │
 *                        └── 任何异常/超时 ──▶ 保持 creating（结果未知，禁止自动重试）
 *
 * `creating` 必须在**第一次微信副作用之前**落盘。此后进程崩了、网络断了，
 * 下一次调用都会看到 creating 并拒绝重试，由人工去草稿箱核对。
 */
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type DeliveryState = {
  status: "creating" | "created";
  title: string;
  updatedAt: string;
  mediaId?: string;
  imageCount?: number;
  /** 该条目对应的草稿已被「更新」覆盖（同一 mediaId 有了更新的内容），不可再复用。 */
  supersededAt?: string;
  /** 该条目对应的草稿已被删除，不可再复用。 */
  deletedAt?: string;
};

/** 该条目是否还能作为"已投递"复用。 */
export function isReusable(state: DeliveryState | undefined): boolean {
  return Boolean(state?.status === "created" && state.mediaId && !state.supersededAt && !state.deletedAt);
}

export class DeliveryLockedError extends Error {
  readonly code = "DELIVERY_LOCKED";
  constructor(message: string) {
    super(message);
    this.name = "DeliveryLockedError";
  }
}

export class DeliveryOutcomeUnknownError extends Error {
  readonly code = "DELIVERY_OUTCOME_UNKNOWN";
  constructor(message: string) {
    super(message);
    this.name = "DeliveryOutcomeUnknownError";
  }
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.WECHAT_DRAFT_STATE_DIR?.trim() || path.join(homedir(), ".wechat-draft-capability", "state");
}

/** 按账号 + 内容哈希分文件：同一账号同一内容才命中幂等，换账号不会互相覆盖。 */
export function stateFile(appId: string, bundleHash: string, env: NodeJS.ProcessEnv = process.env): string {
  const account = createHash("sha256").update(appId || "unknown").digest("hex").slice(0, 16);
  return path.join(stateDir(env), `${account}-${bundleHash}.json`);
}

export async function readDeliveryState(file: string): Promise<DeliveryState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as DeliveryState;
    if (parsed?.status !== "creating" && parsed?.status !== "created") {
      throw new DeliveryOutcomeUnknownError(
        "投递状态文件内容异常。为避免重复创建草稿，已停止操作，请人工检查该文件与公众号草稿箱。"
      );
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof DeliveryOutcomeUnknownError) throw error;
    throw new DeliveryOutcomeUnknownError(
      "投递状态文件无法读取。为避免重复创建草稿，已停止操作，请人工检查后再处理。"
    );
  }
}

export async function writeDeliveryState(file: string, state: DeliveryState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * 单篇互斥锁。
 *
 * 用 `wx`（独占创建）语义：已存在即说明同一篇文章正在处理，或上次进程异常退出。
 * 两种情况都**不自动放行** —— 自动放行就等于允许并发重复建草稿。
 */
export async function withDeliveryLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DeliveryLockedError(
        "同一篇文章正在处理中，或上一次进程异常退出留下了锁。请先到公众号草稿箱核对该文章是否已创建，确认后再删除锁文件重试。"
      );
    }
    throw error;
  }
  try {
    return await run();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * 列出账本里所有条目（不含锁、备份、审计）。
 * 供「更新/删除后把指向同一 mediaId 的旧条目标记为失效」使用 —— 只标记、不删除本地文件。
 */
export async function listDeliveryStateFiles(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dir = stateDir(env);
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .map((name) => path.join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 把某个 mediaId 关联的所有账本条目打上标记（supersededAt / deletedAt）。
 * 返回被改动的条目数。只改本地账本，不动公众号内容。
 */
export async function markDeliveryStates(
  mediaId: string,
  patch: { supersededAt?: string; deletedAt?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<string[]> {
  const changed: string[] = [];
  for (const file of await listDeliveryStateFiles(env)) {
    const state = await readDeliveryState(file);
    if (!state || state.mediaId !== mediaId) continue;
    await writeDeliveryState(file, { ...state, ...patch, updatedAt: new Date().toISOString() });
    changed.push(file);
  }
  return changed;
}
