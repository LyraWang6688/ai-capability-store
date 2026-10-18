/**
 * 统一取价入口：按「定价方式」把持仓路由到对应的数据源。
 *
 *   场内行情 → 腾讯 qt.gtimg.cn（批量）
 *   场外净值 → 东方财富基金历史净值（逐只，限并发）
 *   手工录入 → 不取价（银行存款、理财等没有公开报价的资产）
 */

import { fetchListedQuotes } from './tencent.ts';
import { fetchWindQuotes, windConfigured } from './wind.ts';
import { fetchFundNav } from './eastmoney.ts';
import type { Failure, FetchResult, Quote, QuoteTarget } from './types.ts';

const DEFAULT_LISTED_RETRIES = 2;
const DEFAULT_FUND_CONCURRENCY = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs = 600,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface FetchOptions {
  listedRetries?: number;
  fundConcurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 批量取价。任何单只失败都不会中断整体，失败项写入 failures 由调用方决定如何处理。
 */
export async function fetchQuotes(
  targets: QuoteTarget[],
  options: FetchOptions = {},
): Promise<FetchResult> {
  const listedRetries = options.listedRetries ?? DEFAULT_LISTED_RETRIES;
  const fundConcurrency = options.fundConcurrency ?? DEFAULT_FUND_CONCURRENCY;

  const byRecord = new Map<string, Quote>();
  const failures: Failure[] = [];

  const listed = targets.filter((t) => t.route === '场内行情');
  const funds = targets.filter((t) => t.route === '场外净值');
  const manual = targets.filter((t) => t.route === '手工录入');

  for (const target of manual) {
    failures.push({
      code: target.code,
      name: target.name,
      reason: '手工录入，跳过自动取价',
    });
  }

  // ---- Wind 优先（配置了 WIND_API_KEY 时）：一次拿回全部，含前收盘价 ----
  if (windConfigured()) {
    try {
      const windMap = await fetchWindQuotes(targets.filter((t) => t.route !== '手工录入'));
      if (windMap.size > 0) {
        for (const target of targets) {
          if (target.route === '手工录入') continue;
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
    } catch {
      // Wind 失败就继续走免费源，不阻断同步
    }
  }

  // ---- 场内：一次批量请求 ----
  if (listed.length > 0) {
    const codes = [...new Set(listed.map((t) => t.code))];
    let listedMap: Awaited<ReturnType<typeof fetchListedQuotes>> | null = null;
    try {
      listedMap = await withRetry(() => fetchListedQuotes(codes), listedRetries);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const target of listed) {
        failures.push({ code: target.code, name: target.name, reason: `场内行情获取失败：${reason}` });
      }
    }
    if (listedMap) {
      for (const target of listed) {
        const q = listedMap.get(target.code);
        if (!q) {
          failures.push({
            code: target.code,
            name: target.name,
            reason: '未返回行情（可能停牌、代码无效或已退市）',
          });
          continue;
        }
        byRecord.set(target.recordId, {
          code: q.code,
          name: target.name || q.name,
          price: q.price,
          changePct: q.changePct,
          previousPrice: Number.isFinite(q.prevClose) && q.prevClose > 0 ? q.prevClose : null,
          tradeTime: q.tradeTime,
          source: 'tencent',
        });
      }
    }
    options.onProgress?.(listed.length + manual.length, targets.length);
  }

  // ---- 场外：限并发逐只取净值 ----
  if (funds.length > 0) {
    let done = 0;
    const navs = await mapPool(funds, fundConcurrency, async (target) => {
      try {
        const nav = await withRetry(() => fetchFundNav(target.code), listedRetries);
        done += 1;
        options.onProgress?.(listed.length + manual.length + done, targets.length);
        return nav;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push({ code: target.code, name: target.name, reason: `场外净值获取失败：${reason}` });
        done += 1;
        options.onProgress?.(listed.length + manual.length + done, targets.length);
        return null;
      }
    });

    navs.forEach((nav, index) => {
      const target = funds[index] as QuoteTarget;
      if (!nav) {
        if (!failures.some((f) => f.code === target.code)) {
          failures.push({ code: target.code, name: target.name, reason: '未查到基金净值（代码可能不存在）' });
        }
        return;
      }
      byRecord.set(target.recordId, {
        code: nav.code,
        name: target.name,
        price: nav.nav,
        changePct: nav.changePct,
        previousPrice: nav.previousNav,
        tradeTime: nav.date,
        source: 'eastmoney-fund',
      });
    });
  }

  return { byRecord, failures };
}
