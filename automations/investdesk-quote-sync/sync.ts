#!/usr/bin/env node
/**
 * automations/investdesk-quote-sync 的入口。
 *
 * 这是一个**薄壳**：真正的实现在
 * external-capabilities/mcp/investdesk-quotes/src/sync.ts。
 * 定时任务和 MCP 的 sync_prices 工具共用同一个函数，
 * 所以这里不允许出现第二份取价/写库逻辑。
 *
 * 退出码：
 *   0  成功，或成功率达标
 *   1  成功率低于阈值（场外净值 21:30 前未公布属正常，但仍上报）
 */

import { syncPortfolioPrices } from '../../external-capabilities/mcp/investdesk-quotes/src/sync.ts';

/** 低于这个成功率视为异常退出，便于从日志/监控发现数据源故障 */
const MIN_SUCCESS_RATE = 0.8;

async function main(): Promise<number> {
  const startedAt = Date.now();
  console.log(`[sync] 开始 ${new Date().toISOString()}`);

  let lastLogged = 0;
  const summary = await syncPortfolioPrices({
    onProgress: (done, total) => {
      if (done - lastLogged >= Math.max(1, Math.floor(total / 10))) {
        lastLogged = done;
        console.log(`[sync] 取价进度 ${done}/${total}`);
      }
    },
  });

  if (summary.pending === 0) {
    console.log(`[sync] 持仓 ${summary.total} 条，没有需要自动取价的记录，退出`);
    return 0;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const rate = summary.written / summary.pending;
  console.log(`[sync] 成功 ${summary.written}/${summary.pending}（${(rate * 100).toFixed(1)}%），耗时 ${elapsed}s`);

  if (summary.failures.length > 0) {
    console.warn(`[sync] 失败 ${summary.failures.length} 条：`);
    for (const failure of summary.failures) {
      console.warn(`  ✗ ${failure.code} ${failure.name} — ${failure.reason}`);
    }
  }

  if (rate < MIN_SUCCESS_RATE) {
    console.error(`[sync] 成功率低于 ${MIN_SUCCESS_RATE * 100}%，退出码 1`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[sync] 任务异常：', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
