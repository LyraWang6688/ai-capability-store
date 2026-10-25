/**
 * 持仓价格同步 —— 唯一实现。
 *
 * MCP 的 `sync_prices` 工具与 automations/investdesk-quote-sync 的定时入口
 * 都调用这里的同一个函数，避免两套逻辑随时间漂移。
 *
 * 原则：抓不到就保持原值，绝不写 0。写入后「最新市值」公式自动重算。
 */

import { listHoldingTargets, updateLatestPrices } from '../../../procedures/portfolio-holdings/src/holdings.ts';
import { fetchQuotes } from './quotes/index.ts';
import type { Failure } from './quotes/types.ts';

export interface SyncSummary {
  /** 表内持仓总数 */
  total: number;
  /** 需要自动取价的数量（排除手工录入） */
  pending: number;
  /** 实际写入成功的数量 */
  written: number;
  failures: Failure[];
  elapsedMs: number;
}

export interface SyncOptions {
  onProgress?: (done: number, total: number) => void;
}

/** 抓取全部持仓的最新价格并写回飞书多维表格 */
export async function syncPortfolioPrices(options: SyncOptions = {}): Promise<SyncSummary> {
  const startedAt = Date.now();
  const targets = await listHoldingTargets();
  const pending = targets.filter((target) => target.route !== '手工录入');

  if (pending.length === 0) {
    return { total: targets.length, pending: 0, written: 0, failures: [], elapsedMs: Date.now() - startedAt };
  }

  const { byRecord, failures } = await fetchQuotes(pending, { onProgress: options.onProgress });
  const updates = [...byRecord.entries()].map(([recordId, quote]) => ({
    recordId,
    price: quote.price,
    previousPrice: quote.previousPrice,
    changePct: quote.changePct,
  }));
  const written = await updateLatestPrices(updates);

  return {
    total: targets.length,
    pending: pending.length,
    written,
    failures,
    elapsedMs: Date.now() - startedAt,
  };
}
