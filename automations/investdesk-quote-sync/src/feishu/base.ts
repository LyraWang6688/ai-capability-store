/**
 * 飞书多维表格访问层。
 *
 * **只使用飞书 OpenAPI**（自建应用 tenant_access_token）：
 * 不依赖任何本机凭据，所以本机、云端、CI 走的是同一条路径，
 * 不存在「两套后端行为不一致」的问题。
 *
 * 历史：0.2.x 曾保留 lark-cli（本机用户令牌）作为迁移期后备，
 * 0.3.0 起移除。
 */

import {
  BASE_TOKEN,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_BASE_URL,
  HOLDINGS_TABLE,
  PLATFORMS_TABLE,
  assertFeishuConfigured,
} from '../config.ts';
import type { AssetType, PricingRoute, QuoteTarget } from '../quotes/types.ts';
import type { RawRecord } from './backend.ts';
import { OpenApiBackend } from './openapi.ts';

let cachedBackend: OpenApiBackend | null = null;

/** 当前后端（只有一种，结果缓存） */
export function getBackend(): OpenApiBackend {
  if (cachedBackend) return cachedBackend;
  assertFeishuConfigured();
  cachedBackend = new OpenApiBackend({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    appToken: BASE_TOKEN,
    baseUrl: FEISHU_BASE_URL,
  });
  return cachedBackend;
}

/** 后端名，用于日志（固定值，保留是为了让日志继续可读） */
export function backendName(): string {
  return 'openapi';
}

/** 单选字段：OpenAPI 返回字符串，兼容数组形态 */
function firstOf(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? '');
  if (typeof value === 'string') return value;
  return '';
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
  /** 昨收价 / 昨日净值 */
  previousPrice: number | null;
  /** 日涨跌幅（%） */
  changePct: number | null;
  /** 日盈亏（表内公式字段） */
  dailyPnl: number | null;
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
    previousPrice: toNumber(record.昨收价),
    changePct: toNumber(record['日涨跌幅(%)']),
    dailyPnl: toNumber(record.日盈亏),
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
  /** 昨收价 / 昨日净值；为空则不改动该字段 */
  previousPrice?: number | null;
  /** 日涨跌幅（%）；为空则不改动该字段 */
  changePct?: number | null;
}

/**
 * 把行情写回「最新持仓」：
 *   最新价格 / 昨收价 / 日涨跌幅(%)
 * 「最新市值」「日盈亏」是公式字段，写完后自动重算。
 */
export async function updateLatestPrices(updates: PriceUpdate[]): Promise<number> {
  if (updates.length === 0) return 0;
  return getBackend().batchUpdateRecords(
    HOLDINGS_TABLE,
    updates.map((update) => {
      const fields: Record<string, unknown> = { 最新价格: update.price };
      if (update.previousPrice != null) fields.昨收价 = update.previousPrice;
      if (update.changePct != null) fields['日涨跌幅(%)'] = update.changePct;
      return { recordId: update.recordId, fields };
    }),
  );
}
