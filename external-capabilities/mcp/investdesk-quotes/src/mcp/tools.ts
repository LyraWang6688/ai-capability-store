/**
 * MCP 工具定义与实现。
 *
 * 这层把「行情 + 持仓」能力包装成 MCP tool，供豆包工作、Claude Desktop
 * 或其他 MCP 客户端调用。核心逻辑复用 src/quotes 和 src/feishu，不重复实现。
 */

import { listHoldings, listPlatformNames } from '../feishu/base.ts';
import { fetchQuotes } from '../quotes/index.ts';
import type { PricingRoute, QuoteTarget } from '../quotes/types.ts';
import { syncPortfolioPrices } from '../sync.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

function errorText(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }], isError: true };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'lookup_quotes',
    description:
      '查询 A 股场内标的或场外公募基金的最新价格。场内支持个股、ETF、LOF、REITs，批量一次最多 60 个代码。' +
      '注意：同一个 6 位代码可能既是股票又是场外基金（例如 000866 既是已退市的扬子石化，也是华宝制造股票），' +
      '所以查场外基金时必须显式传 route="场外净值"。',
    inputSchema: {
      type: 'object',
      properties: {
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: '6 位证券/基金代码列表，例如 ["510300","600028","008284"]',
        },
        route: {
          type: 'string',
          enum: ['场内行情', '场外净值'],
          description: '定价方式；默认场内行情',
        },
      },
      required: ['codes'],
    },
  },
  {
    name: 'portfolio_overview',
    description:
      '读取飞书多维表格里的最新持仓，按平台汇总市值、成本、盈亏与收益率，并返回市值最大的若干只持仓。' +
      '数据来自「最新持仓」表，市值由「持有数量 × 最新价格」公式计算。',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: '只统计某个平台，例如「雪球基金」「招商证券-551」；省略则统计全部',
        },
        top: {
          type: 'number',
          description: '返回市值最大的前 N 只，默认 10',
        },
      },
    },
  },
  {
    name: 'sync_prices',
    description:
      '立即从腾讯行情和东方财富净值源抓取全部持仓的最新价格，并写回飞书多维表格。' +
      '这是一次写操作；每日定时任务已自动执行，通常只在用户明确要求立即刷新时调用。',
    inputSchema: { type: 'object', properties: {} },
  },
];

function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function lookupQuotes(args: Record<string, unknown>): Promise<ToolResult> {
  const codes = Array.isArray(args.codes) ? args.codes.map(String) : [];
  if (codes.length === 0) return errorText('缺少参数 codes');
  const route = (args.route as PricingRoute) ?? '场内行情';
  const targets: QuoteTarget[] = codes.map((code) => ({
    recordId: code,
    code,
    name: '',
    assetType: '',
    route,
  }));

  const { byRecord, failures } = await fetchQuotes(targets);
  const lines: string[] = [`取价 ${byRecord.size}/${codes.length} 条（${route}）`, ''];
  for (const quote of byRecord.values()) {
    const pct = quote.changePct === null ? '-' : `${quote.changePct > 0 ? '+' : ''}${quote.changePct}%`;
    lines.push(`${quote.code} ${quote.name || ''} 价格 ${quote.price} 涨跌 ${pct} 时间 ${quote.tradeTime}`);
  }
  if (failures.length > 0) {
    lines.push('', '未取到：');
    for (const failure of failures) lines.push(`  ${failure.code} — ${failure.reason}`);
  }
  return text(lines.join('\n'));
}

interface Aggregate {
  count: number;
  marketValue: number;
  cost: number;
}

async function portfolioOverview(args: Record<string, unknown>): Promise<ToolResult> {
  const platformFilter = typeof args.platform === 'string' ? args.platform : '';
  const top = typeof args.top === 'number' && args.top > 0 ? args.top : 10;

  const [holdings, platformNames] = await Promise.all([listHoldings(), listPlatformNames()]);

  const rows = holdings
    .filter((h) => h.route !== '手工录入')
    .map((h) => {
      const platform = platformNames.get(h.platformId) ?? '未归属';
      const marketValue = h.marketValue ?? 0;
      const cost = (h.quantity ?? 0) * (h.unitCost ?? 0);
      return { ...h, platform, marketValue, cost };
    })
    .filter((h) => (platformFilter ? h.platform === platformFilter : true));

  if (rows.length === 0) {
    return text(platformFilter ? `平台「${platformFilter}」下没有持仓记录` : '没有持仓记录');
  }

  const byPlatform = new Map<string, Aggregate>();
  let totalValue = 0;
  let totalCost = 0;
  for (const row of rows) {
    const agg = byPlatform.get(row.platform) ?? { count: 0, marketValue: 0, cost: 0 };
    agg.count += 1;
    agg.marketValue += row.marketValue;
    agg.cost += row.cost;
    byPlatform.set(row.platform, agg);
    totalValue += row.marketValue;
    totalCost += row.cost;
  }

  const lines: string[] = ['## 持仓概览', '', '| 平台 | 持仓数 | 市值 | 成本 | 盈亏 | 收益率 |', '|---|---:|---:|---:|---:|---:|'];
  for (const [name, agg] of [...byPlatform.entries()].sort((a, b) => b[1].marketValue - a[1].marketValue)) {
    const pnl = agg.marketValue - agg.cost;
    const rate = agg.cost > 0 ? `${((pnl / agg.cost) * 100).toFixed(2)}%` : '-';
    lines.push(`| ${name} | ${agg.count} | ${formatNumber(agg.marketValue)} | ${formatNumber(agg.cost)} | ${formatNumber(pnl)} | ${rate} |`);
  }
  const totalPnl = totalValue - totalCost;
  const totalRate = totalCost > 0 ? `${((totalPnl / totalCost) * 100).toFixed(2)}%` : '-';
  lines.push(`| **合计** | **${rows.length}** | **${formatNumber(totalValue)}** | **${formatNumber(totalCost)}** | **${formatNumber(totalPnl)}** | **${totalRate}** |`);

  lines.push('', `## 市值前 ${top} 只`, '', '| 代码 | 名称 | 平台 | 市值 | 盈亏 | 收益率 |', '|---|---|---|---:|---:|---:|');
  const sorted = [...rows].sort((a, b) => b.marketValue - a.marketValue).slice(0, top);
  for (const row of sorted) {
    const pnl = row.marketValue - row.cost;
    const rate = row.cost > 0 ? `${((pnl / row.cost) * 100).toFixed(2)}%` : '-';
    lines.push(`| ${row.code} | ${row.name} | ${row.platform} | ${formatNumber(row.marketValue)} | ${formatNumber(pnl)} | ${rate} |`);
  }

  const missing = rows.filter((row) => row.quantity === null || row.quantity === 0);
  if (missing.length > 0) {
    lines.push('', `⚠️ ${missing.length} 只没有持有数量，未计入市值：${missing.map((m) => m.code).join('、')}`);
  }

  return text(lines.join('\n'));
}

async function syncPrices(): Promise<ToolResult> {
  const summary = await syncPortfolioPrices();

  const lines = [`已刷新 ${summary.written}/${summary.pending} 只的最新价格`];
  if (summary.failures.length > 0) {
    lines.push('', `失败 ${summary.failures.length} 条：`);
    for (const failure of summary.failures) lines.push(`  ${failure.code} ${failure.name} — ${failure.reason}`);
  }
  return text(lines.join('\n'));
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'lookup_quotes':
      return lookupQuotes(args);
    case 'portfolio_overview':
      return portfolioOverview(args);
    case 'sync_prices':
      return syncPrices();
    default:
      return errorText(`未知工具：${name}`);
  }
}
