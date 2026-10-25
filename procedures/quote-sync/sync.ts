#!/usr/bin/env node
/**
 * 持仓价格同步 —— 每个交易日一次，把最新价写回飞书多维表格。
 *
 * 自包含：取价（Wind）、读写飞书、汇总逻辑都在 ./src/ 下，
 * 不再引用外部能力包。数据源只有 Wind（免费网页源已移除）。
 *
 * 退出码：
 *   0  成功，或成功率达标
 *   1  成功率低于阈值，或配置缺失（如 WIND_API_KEY）
 */

import { backendName } from '../../procedures/portfolio-holdings/src/holdings.ts';
import { syncPortfolioPrices } from './src/portfolio.ts';
import { buildSyncNotifyText, sendNotifyMessage } from './src/notify.ts';

/** 低于这个成功率视为异常退出，便于从日志/监控发现数据源故障 */
const MIN_SUCCESS_RATE = 0.8;

/**
 * 同步成功后发通知（事件信号），失败只警告不影响主流程退出码。
 * NOTIFY_* 未配置时静默跳过，避免阻塞价格同步。
 */
async function notifySyncCompleted(summary: {
  total: number;
  written: number;
  failures: number;
}): Promise<void> {
  const appId = process.env.NOTIFY_APP_ID ?? '';
  const appSecret = process.env.NOTIFY_APP_SECRET ?? '';
  const chatId = process.env.NOTIFY_CHAT_ID ?? '';
  if (!appId || !appSecret || !chatId) {
    console.warn('[notify] 未配置 NOTIFY_APP_ID/NOTIFY_APP_SECRET/NOTIFY_CHAT_ID，跳过同步完成通知');
    return;
  }
  try {
    await sendNotifyMessage({ appId, appSecret, chatId }, buildSyncNotifyText(summary));
  } catch (error) {
    console.warn('[notify] 通知发送失败（不影响同步结果）：', error instanceof Error ? error.message : error);
  }
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  console.log(`[sync] 开始 ${new Date().toISOString()} | 飞书后端: ${backendName()}`);

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

  // 同步成功 → 发事件通知（豆包侧监听后触发持仓日报）
  await notifySyncCompleted({ total: summary.total, written: summary.written, failures: summary.failures.length });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[sync] 任务异常：', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
