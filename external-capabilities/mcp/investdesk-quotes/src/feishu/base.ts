/**
 * 飞书多维表格访问层。
 *
 * 直接复用本机已授权的 lark-cli，不额外引入 SDK、也不保存 app secret。
 * 所有命令都带 `--as user`，代表用户本人操作其 Base。
 *
 * 注意：lark-cli 的 --output / @file 只接受相对路径，所以所有命令的 cwd
 * 都固定为工作目录 WORK_DIR，产物也落在 WORK_DIR/.cache 下。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AssetType, PricingRoute, QuoteTarget } from '../quotes/types.ts';
import {
  BASE_TOKEN,
  CACHE_DIR,
  HOLDINGS_TABLE,
  LARK_CLI,
  PLATFORMS_TABLE,
  WORK_DIR,
  assertFeishuConfigured,
} from '../config.ts';

const execFileAsync = promisify(execFile);

interface RawRecord {
  record_id: string;
  代码?: string | null;
  名称?: string | null;
  资产种类?: string[] | null;
  定价方式?: string[] | null;
  [key: string]: unknown;
}

interface LarkEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { message?: string; code?: number };
}

async function runLarkCli(args: string[]): Promise<string> {
  assertFeishuConfigured();
  try {
    const { stdout } = await execFileAsync(LARK_CLI, args, {
      cwd: WORK_DIR,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    const detail = (err.stderr || err.stdout || err.message || '').slice(0, 800);
    throw new Error(`lark-cli 执行失败：${detail}`);
  }
}

function parseEnvelope<T>(stdout: string): T {
  const envelope = JSON.parse(stdout) as LarkEnvelope<T>;
  if (!envelope.ok) {
    throw new Error(`飞书接口返回失败：${envelope.error?.message ?? 'unknown'}`);
  }
  return envelope.data as T;
}

function firstOf(value: string[] | null | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : '';
}

export interface HoldingRecord {
  recordId: string;
  code: string;
  name: string;
  platformId: string;
  assetType: AssetType | '';
  route: PricingRoute;
  quantity: number | null;
  unitCost: number | null;
  price: number | null;
  marketValue: number | null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function pullTable(tableId: string, relativeOut: string, limit: number): Promise<RawRecord[]> {
  await mkdir(CACHE_DIR, { recursive: true });
  // --output 模式下 stdout 是 ndjson manifest（没有 ok 字段），真正的记录
  // 写在文件里；命令失败时 runLarkCli 会抛错。
  await runLarkCli([
    'base', '+record-list',
    '--base-token', BASE_TOKEN,
    '--table-id', tableId,
    '--limit', String(limit),
    '--format', 'ndjson',
    '--output', relativeOut,
    '--overwrite',
    '--as', 'user',
  ]);
  const ndjson = await readFile(path.join(WORK_DIR, relativeOut), 'utf8');
  return ndjson
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawRecord);
}

/** 读取「最新持仓」全部记录 */
export async function listHoldings(): Promise<HoldingRecord[]> {
  const records = await pullTable(HOLDINGS_TABLE, '.cache/holdings.ndjson', 2000);
  return records.map((record) => ({
    recordId: record.record_id,
    code: (record.代码 ?? '').trim(),
    name: (record.名称 ?? '').trim(),
    platformId: Array.isArray(record.投资平台) && record.投资平台[0]
      ? (record.投资平台[0] as { id: string }).id
      : '',
    assetType: firstOf(record.资产种类) as AssetType | '',
    route: firstOf(record.定价方式) as PricingRoute,
    quantity: toNumber(record.持有数量),
    unitCost: toNumber(record.单位成本),
    price: toNumber(record.最新价格),
    marketValue: toNumber(record.最新市值),
  }));
}

/** 读取「最新持仓」并转换为取价目标 */
export async function listHoldingTargets(): Promise<QuoteTarget[]> {
  const holdings = await listHoldings();
  return holdings.map((holding) => ({
    recordId: holding.recordId,
    code: holding.code,
    name: holding.name,
    assetType: holding.assetType,
    route: holding.route,
  }));
}

/** 读取「持仓平台」表，返回 record_id → 平台名 的映射 */
export async function listPlatformNames(): Promise<Map<string, string>> {
  const records = await pullTable(PLATFORMS_TABLE, '.cache/platforms.ndjson', 200);
  const map = new Map<string, string>();
  for (const record of records) {
    map.set(record.record_id, (record.平台 as string) ?? '未命名');
  }
  return map;
}

export interface PriceUpdate {
  recordId: string;
  price: number;
}

/** 把价格写回「最新持仓」的「最新价格」字段（写入后「最新市值」公式自动重算） */
export async function updateLatestPrices(updates: PriceUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;
  await mkdir(CACHE_DIR, { recursive: true });

  let written = 0;
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const payload: Record<string, { 最新价格: number }> = {};
    for (const update of chunk) payload[update.recordId] = { 最新价格: update.price };

    const fileName = `.cache/patch-${Date.now()}-${i}.json`;
    const absolute = path.join(WORK_DIR, fileName);
    await writeFile(absolute, JSON.stringify({ update_records: payload }), 'utf8');
    try {
      const stdout = await runLarkCli([
        'base', '+record-batch-update',
        '--base-token', BASE_TOKEN,
        '--table-id', HOLDINGS_TABLE,
        '--json', `@./${fileName}`,
        '--as', 'user',
      ]);
      parseEnvelope<{ record_id_list?: string[] }>(stdout);
      written += chunk.length;
    } finally {
      await rm(absolute, { force: true });
    }
  }
  return written;
}
