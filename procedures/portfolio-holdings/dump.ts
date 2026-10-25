#!/usr/bin/env node
/**
 * 取一次持仓，打印成 JSON。这是本 procedure 的入口：
 * 它把「怎么从飞书多维表格取出持仓」这件事独立成一个可单独运行的动作，
 * 不依赖任何宿主，也不依赖调用方是不是 skill。
 *
 * 用法：node src/dump.ts            # 打印持仓 + 平台名映射
 * 环境变量见 ../../../automations/investdesk-quote-sync/src/config.ts
 *   INVESTDESK_BASE_TOKEN / INVESTDESK_HOLDINGS_TABLE / INVESTDESK_PLATFORMS_TABLE
 *   FEISHU_APP_ID / FEISHU_APP_SECRET
 */
import { listHoldings, listPlatformNames } from './src/holdings.ts';

async function main(): Promise<void> {
  const [holdings, platforms] = await Promise.all([listHoldings(), listPlatformNames()]);
  const payload = {
    count: holdings.length,
    platforms: Object.fromEntries(platforms),
    holdings,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`取持仓失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
