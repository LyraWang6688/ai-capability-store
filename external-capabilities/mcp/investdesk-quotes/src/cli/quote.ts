/**
 * 手动查价 CLI。
 *
 *   node src/cli/quote.ts 510300 600028 512670      # 场内
 *   node src/cli/quote.ts f:008284 f:110017         # 场外（f: 前缀强制走净值）
 *
 * 加 f: 前缀是必要的：同一串 6 位代码可能既是股票又是场外基金
 * （000866 既是已退市的扬子石化，也是华宝制造股票），不能靠规则猜。
 */

import { fetchQuotes } from '../quotes/index.ts';
import type { PricingRoute, QuoteTarget } from '../quotes/types.ts';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('用法: node src/cli/quote.ts <代码...>   （场外请加 f: 前缀，如 f:008284）');
  process.exit(2);
}

const targets: QuoteTarget[] = args.map((raw) => {
  const isFund = raw.toLowerCase().startsWith('f:');
  const code = isFund ? raw.slice(2) : raw;
  const route: PricingRoute = isFund ? '场外净值' : '场内行情';
  return { recordId: code, code, name: '', assetType: '', route };
});

const { byRecord, failures } = await fetchQuotes(targets);

const rows = [...byRecord.values()].map((quote) => ({
  代码: quote.code,
  名称: quote.name,
  价格: quote.price,
  涨跌幅: quote.changePct === null ? '-' : `${quote.changePct}%`,
  时间: quote.tradeTime,
  来源: quote.source,
}));

if (rows.length > 0) console.table(rows);

if (failures.length > 0) {
  console.log(`\n未取到 ${failures.length} 条：`);
  for (const failure of failures) console.log(`  ✗ ${failure.code} — ${failure.reason}`);
  process.exit(1);
}
