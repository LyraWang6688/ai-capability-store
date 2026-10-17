/**
 * 飞书多维表格访问层 —— 对上层暴露稳定的记录接口，底层可切换后端。
 *
 * 后端选择只看环境变量：
 *   有 FEISHU_APP_ID + FEISHU_APP_SECRET → OpenAPI（云端 / CI 可用）
 *   没有                                 → 本机 lark-cli（用户令牌在 keychain）
 *
 * 上层代码（quotes / sync / mcp）完全不需要知道用的是哪种。
 */

import {
  BASE_TOKEN,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_BASE_URL,
  HOLDINGS_TABLE,
  PLATFORMS_TABLE,
  assertFeishuConfigured,
  hasAppCredentials,
} from '../config.ts';
import type { AssetType, PricingRoute, QuoteTarget } from '../quotes/types.ts';
import type { FeishuBackend, RawRecord } from './backend.ts';
import { LarkCliBackend } from './larkCli.ts';
import { OpenApiBackend } from './openapi.ts';

let cachedBackend: FeishuBackend | null = null;

/** 当前生效的后端（按环境变量选择，结果缓存） */
export function getBackend(): FeishuBackend {
  if (cachedBackend) return cachedBackend;
  assertFeishuConfigured();
  cachedBackend = hasAppCredentials()
    ? new OpenApiBackend({
        appId: FEISHU_APP_ID,
        appSecret: FEISHU_APP_SECRET,
        appToken: BASE_TOKEN,
        baseUrl: FEISHU_BASE_URL,
      })
    : new LarkCliBackend();
  return cachedBackend;
}

/** 后端名，用于日志 */
export function backendName(): string {
  return hasAppCredentials() ? 'openapi' : 'lark-cli';
}

function firstOf(value: string[] | null | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : '';
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
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

/** 读取「最新持仓」全部记录 */
export async function listHoldings(): Promise<HoldingRecord[]> {
  const records: RawRecord[] = await getBackend().listRecords(HOLDINGS_TABLE, 2000);
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
  const records: RawRecord[] = await getBackend().listRecords(PLATFORMS_TABLE, 200);
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
  return getBackend().batchUpdateRecords(
    HOLDINGS_TABLE,
    updates.map((update) => ({ recordId: update.recordId, fields: { 最新价格: update.price } })),
  );
}
