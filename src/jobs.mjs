/**
 * 后台任务账本（文件实现）
 *
 * 为什么需要：
 * 单次分析要 60~120 秒，而宿主的 MCP 工具有 `tools/call total timeout`。
 * 如果分析同步跑，一旦超时：宿主只看到"工具失败"，**这一分钟的算力就白费了**，
 * 而且模型拿不到任何结果或指引。
 *
 * 做法：分析一律以独立进程后台跑，状态落文件。
 * - 宿主等得起：直接把结果返回
 * - 宿主等不起：立刻返回 job_id，稍后用 teaming_job_status 取
 * - 宿主彻底断了：任务照跑，下次仍能取到
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const JOBS_DIR = process.env.TEAMING_JOBS || join(ROOT, '.state', 'jobs');

const KEEP_MS = 7 * 24 * 3600 * 1000;   // 账本保留 7 天

export function newJobId() {
  const t = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `job-${t}-${r}`;
}

function pathFor(jobId) {
  // 只允许我们自己生成的形状，避免路径穿越
  if (!/^job-[0-9a-zA-Z-]{1,40}$/.test(String(jobId))) throw new Error(`非法 job_id：${jobId}`);
  return join(JOBS_DIR, `${jobId}.json`);
}

export function writeJob(jobId, patch) {
  mkdirSync(JOBS_DIR, { recursive: true });
  const p = pathFor(jobId);
  let cur = {};
  if (existsSync(p)) { try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch { cur = {}; } }
  const next = { ...cur, ...patch, jobId, updatedAt: new Date().toISOString() };
  writeFileSync(p, JSON.stringify(next, null, 2));
  return next;
}

export function readJob(jobId) {
  const p = pathFor(jobId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function listJobs(limit = 10) {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(JOBS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}

/** 清掉过期账本，避免无限增长 */
export function pruneJobs() {
  if (!existsSync(JOBS_DIR)) return 0;
  const now = Date.now();
  let n = 0;
  for (const f of readdirSync(JOBS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const p = join(JOBS_DIR, f);
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const t = Date.parse(j.updatedAt || j.startedAt || 0);
      if (Number.isFinite(t) && now - t > KEEP_MS) { unlinkSync(p); n += 1; }
    } catch { /* 坏文件留给人工看，不自动删 */ }
  }
  return n;
}

/** 轮询等一个任务到终态；超时返回 null（任务仍在跑，不算失败） */
export async function waitForJob(jobId, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = readJob(jobId);
    if (!j) return null;
    if (j.status === 'done' || j.status === 'failed') return j;
    if (Date.now() >= deadline) return j;      // 仍在 running，原样返回
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
