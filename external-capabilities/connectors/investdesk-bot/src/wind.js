/**
 * Wind MCP 客户端（裸 HTTP JSON-RPC + SSE）。
 *
 * 协议依据：wind-mcp-skill 的 scripts/cli.mjs
 *   POST https://mcp.wind.com.cn/vserver_<domain>/mcp/
 *   Authorization: Bearer <WIND_API_KEY>
 *   Accept: application/json, text/event-stream
 *   无状态：每次先 initialize，再 tools/call
 *
 * 积分政策：每日赠送 1000 积分；调用失败不扣。所以失败可以重试，
 * 但成功的调用要省着用——上层只在「推荐类问题」时调这里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVERS = {
  stock_data: 'https://mcp.wind.com.cn/vserver_stock_data/mcp/',
  fund_data: 'https://mcp.wind.com.cn/vserver_fund_data/mcp/',
  index_data: 'https://mcp.wind.com.cn/vserver_index_data/mcp/',
  financial_docs: 'https://mcp.wind.com.cn/vserver_financial_docs/mcp/',
};

/** 优先环境变量，其次 ~/.wind-aifinmarket/config（与官方 CLI 一致） */
function getApiKey() {
  if (process.env.WIND_API_KEY?.trim()) return process.env.WIND_API_KEY.trim();
  try {
    const file = path.join(os.homedir(), '.wind-aifinmarket', 'config');
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*WIND_API_KEY\s*=\s*(.+)\s*$/.exec(line);
      if (match) return match[1].trim();
    }
  } catch {
    /* 没配置就走下面的报错 */
  }
  throw new Error('WIND_API_KEY 未配置');
}

/** 解析响应：可能是纯 JSON，也可能是 SSE（data: {...}） */
function parsePayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const lines = trimmed.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') return JSON.parse(data);
    }
  }
  throw new Error('无法解析 Wind 响应');
}

async function mcpRequest(serverType, method, params) {
  const endpoint = SERVERS[serverType];
  if (!endpoint) throw new Error(`未知的 Wind 数据域：${serverType}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Wind HTTP ${response.status}: ${text.slice(0, 200)}`);
  const payload = parsePayload(text);
  if (payload.error) {
    const code = payload.error.code ?? 'backend_error';
    throw new Error(`Wind ${code}: ${payload.error.message ?? ''}`);
  }
  return payload.result;
}

/** 调一次 Wind 工具，返回原始 content[0].text（里面是 JSON 字符串） */
export async function windCall(serverType, toolName, args) {
  await mcpRequest(serverType, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'investdesk-bot', version: '0.1.0' },
  });
  const result = await mcpRequest(serverType, 'tools/call', { name: toolName, arguments: args });
  if (result?.isError) {
    const detail = result.content?.[0]?.text ?? 'Wind 返回错误';
    throw new Error(detail);
  }
  return result?.content?.[0]?.text ?? '';
}

/** 把 Wind 的 {data:{columns,rows}} 转成可读文本（兼容嵌套 data.data[]） */
function formatTable(text, maxRows = 20) {
  try {
    const parsed = JSON.parse(text);
    let data = parsed.data ?? parsed;
    // 部分工具返回 { data: { data: [ {columns, rows} ] } }
    if (Array.isArray(data?.data)) data = data.data[0] ?? {};
    const columns = (data.columns ?? []).map((column) => column.name);
    const rows = data.rows ?? [];
    if (columns.length === 0 || rows.length === 0) return text.slice(0, 500);
    const lines = rows.slice(0, maxRows).map((row) =>
      columns.map((name, index) => `${name}=${row[index] ?? ''}`).join(' | '),
    );
    return lines.join('\n') + (rows.length > maxRows ? `\n（共 ${rows.length} 条，仅显示前 ${maxRows} 条）` : '');
  } catch {
    return text.slice(0, 800);
  }
}

/** 自然语言筛选基金（ETF/LOF/场外） */
export async function searchFunds(question) {
  const text = await windCall('fund_data', 'search_funds', { question });
  return formatTable(text, 20);
}

/** 批量行情快照 */
export async function fundSnapshot(codes) {
  const windcodes = codes.map((code) => (/\.(SH|SZ)$/i.test(code) ? code.toUpperCase() : `${code}.${/^(5|6|9)/.test(code) ? 'SH' : 'SZ'}`));
  const text = await windCall('fund_data', 'get_fund_price_indicators', {
    windcode: windcodes.join(','),
    indexes: '最新交易日,中文简称,最新成交价,涨跌幅,成交额,换手率,当日主力净流入额,近5日主力净流入额',
  });
  return formatTable(text, 20);
}

/** 基金档案（费率、跟踪指数、基金经理等）—— NL 类工具，用自然语言提问 */
export async function fundProfile(windcode) {
  const text = await windCall('fund_data', 'get_fund_info', {
    question: `查询基金 ${toWindCode(windcode)} 的投资类型与风格、跟踪指数、管理费率、现任基金经理、成立日期`,
  });
  return formatTable(text, 10);
}

/** 自然语言筛选股票 */
export async function searchStocks(question) {
  const text = await windCall('stock_data', 'search_stocks', { question });
  return formatTable(text, 20);
}

export function toWindCode(code) {
  if (/\.(SH|SZ|BJ)$/i.test(code)) return code.toUpperCase();
  return `${code}.${/^(5|6|9)/.test(code) ? 'SH' : 'SZ'}`;
}
