/**
 * Wind（万得）行情源。
 *
 * 为什么加它：免费源（腾讯/东财）能取到价格，但没有权威的「前收盘价」，
 * 而且接口不稳定。Wind 一次调用可以把全部持仓批量取回来（实测 68 只场内
 * 一次返回），并且直接给「前收盘价」和官方简称，日盈亏口径更准。
 *
 * 成本：每次同步只需 2 次调用（场内一批 + 场外一批），每天 2 次同步 = 4 次。
 * 走 MCP over HTTP，Authorization: Bearer <WIND_API_KEY>。
 */
import { WIND_API_KEY } from '../config.ts';
import type { Quote, QuoteTarget } from './types.ts';

const WIND_ENDPOINT = 'https://mcp.wind.com.cn/vserver_fund_data/mcp/';
const INDEXES = '最新交易日,中文简称,最新成交价,前收盘价,涨跌幅';

export function windConfigured(): boolean {
  return Boolean(WIND_API_KEY);
}

function parsePayload(text: string): any {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') return JSON.parse(data);
    }
  }
  throw new Error('无法解析 Wind 响应');
}

async function mcpRequest(method: string, params: unknown): Promise<any> {
  const response = await fetch(WIND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WIND_API_KEY}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Wind HTTP ${response.status}`);
  const payload = parsePayload(text);
  if (payload.error) throw new Error(`Wind ${payload.error.code}: ${payload.error.message}`);
  return payload.result;
}

/** 6 位代码 → Wind 代码 */
function toWindCode(code: string, otc: boolean): string {
  const clean = code.replace(/\D/g, '').padStart(6, '0');
  if (otc) return `${clean}.OF`;
  return `${clean}.${/^(5|6|9)/.test(clean) ? 'SH' : 'SZ'}`;
}

/** 当日调用计数（进程内），用于观察积分消耗 */
const windUsage = { calls: 0 };
export function windCallCount(): number {
  return windUsage.calls;
}

async function fetchGroup(targets: QuoteTarget[], otc: boolean): Promise<Map<string, Quote>> {
  const result = new Map<string, Quote>();
  if (targets.length === 0) return result;

  const codes = [...new Set(targets.map((t) => toWindCode(t.code, otc)))];
  await mcpRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'investdesk-quote-sync', version: '0.2.0' },
  });
  windUsage.calls += 1;
  console.log(`[wind] 第 ${windUsage.calls} 次调用（${otc ? '场外' : '场内'} ${codes.length} 只）`);
  const call = await mcpRequest('tools/call', {
    name: 'get_fund_price_indicators',
    arguments: { windcode: codes.join(','), indexes: INDEXES },
  });
  if (call?.isError) throw new Error(call.content?.[0]?.text ?? 'Wind 返回错误');

  const parsed = JSON.parse(call.content[0].text);
  const table = parsed.data ?? parsed;
  const columns: string[] = (table.columns ?? []).map((c: { name: string }) => c.name);
  const rows: unknown[][] = table.rows ?? [];

  const idx = (name: string) => columns.indexOf(name);
  const iDate = idx('最新交易日');
  const iName = idx('中文简称');
  const iPrice = idx('最新成交价');
  const iPrev = idx('前收盘价');
  const iPct = idx('涨跌幅');
  const iCode = idx('Wind代码');

  // Wind 代码 → 原始 6 位代码
  const backToCode = new Map<string, string>();
  for (const target of targets) {
    backToCode.set(toWindCode(target.code, otc), target.code.replace(/\D/g, '').padStart(6, '0'));
  }

  for (const row of rows) {
    const windCode = String(row[iCode] ?? '');
    const code = backToCode.get(windCode);
    if (!code) continue;
    const price = Number(row[iPrice]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const prev = Number(row[iPrev]);
    const pct = Number(row[iPct]);
    result.set(code, {
      code,
      name: String(row[iName] ?? ''),
      price,
      changePct: Number.isFinite(pct) ? pct : null,
      previousPrice: Number.isFinite(prev) && prev > 0 ? prev : null,
      tradeTime: String(row[iDate] ?? ''),
      source: 'wind' as never,
    });
  }
  return result;
}

/** 一次性取回全部持仓行情（场内一批 + 场外一批） */
export async function fetchWindQuotes(targets: QuoteTarget[]): Promise<Map<string, Quote>> {
  const listed = targets.filter((t) => t.route === '场内行情');
  const otc = targets.filter((t) => t.route === '场外净值');
  const merged = new Map<string, Quote>();
  const listedMap = await fetchGroup(listed, false);
  for (const [code, quote] of listedMap) merged.set(code, quote);
  const otcMap = await fetchGroup(otc, true);
  for (const [code, quote] of otcMap) merged.set(code, quote);
  return merged;
}
