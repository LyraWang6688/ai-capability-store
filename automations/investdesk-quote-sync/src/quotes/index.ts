/**
 * 取价主流程。
 *
 * 决策（2026-10）：持仓价格的唯一数据源是 **Wind（万得）**，不再使用腾讯/东财
 * 等免费网页接口。原因：
 *   - 免费源没有权威「前收盘价」，日盈亏要靠涨跌幅反推
 *   - 免费源不稳定（东财会 RemoteDisconnected），要重试 + 多域名 + 回退
 *   - Wind 一次调用能拿回全部持仓（实测 68 只场内一次返回），
 *     每次同步只需 2 次调用，对每日 1000 免费积分来说可忽略
 *
 * 代价：Wind 不可用时没有兜底。此时同步会失败并保留表里的旧价格，
 * 不会写入 0（「抓不到就保持原值」是既有约束）。
 */
import { fetchWindQuotes, windConfigured } from './wind.ts';
import type { Failure, FetchResult, Quote, QuoteTarget } from './types.ts';

export interface FetchOptions {
  onProgress?: (done: number, total: number) => void;
}

export async function fetchQuotes(
  targets: QuoteTarget[],
  options: FetchOptions = {},
): Promise<FetchResult> {
  const byRecord = new Map<string, Quote>();
  const failures: Failure[] = [];

  for (const target of targets) {
    if (target.route === '手工录入') {
      failures.push({ code: target.code, name: target.name, reason: '手工录入，跳过自动取价' });
    }
  }

  const auto = targets.filter((target) => target.route !== '手工录入');
  if (auto.length === 0) return { byRecord, failures };

  if (!windConfigured()) {
    throw new Error('未配置 WIND_API_KEY：免费行情源已移除，取价必须走 Wind');
  }

  options.onProgress?.(0, auto.length);
  const windMap = await fetchWindQuotes(auto);
  options.onProgress?.(auto.length, auto.length);

  for (const target of auto) {
    const code = target.code.replace(/\D/g, '').padStart(6, '0');
    const quote = windMap.get(code);
    if (!quote) {
      failures.push({ code: target.code, name: target.name, reason: 'Wind 未返回该标的行情' });
      continue;
    }
    byRecord.set(target.recordId, { ...quote, name: target.name || quote.name });
  }

  return { byRecord, failures };
}
