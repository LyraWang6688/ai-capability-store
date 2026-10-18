import { fetchGbk, fetchJson, fetchJsonFromHosts, toSecId } from './http.ts';

interface EastmoneyListResponse {
  data?: { total?: number; diff?: Array<Record<string, unknown>> };
}

/**
 * 行业板块涨跌排行。
 *
 * 东财接口带主力资金净额，但实测不稳定（同一 URL 时而正常、时而 RemoteDisconnected）。
 * 所以东财失败时回退到新浪行业板块（稳定，但没有资金流数据）。
 */
export async function sectorRanking(input: { type?: '行业' | '概念'; limit?: number; direction?: '涨' | '跌' }): Promise<string> {
  try {
    return await sectorRankingEastmoney(input);
  } catch (error) {
    const fallback = await sectorRankingSina(input);
    return `${fallback}\n\n（东方财富接口暂不可用，已回退新浪数据；本次不含主力资金流）`;
  }
}

async function sectorRankingSina(input: { limit?: number; direction?: '涨' | '跌' }): Promise<string> {
  const text = await fetchGbk(
    'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php',
    'https://finance.sina.com.cn/',
  );
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('新浪板块数据解析失败');
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, string>;
  const rows = Object.values(raw).map((line) => {
    const parts = String(line).split(',');
    return { name: parts[1] ?? '', pct: Number(parts[5] ?? 0), leader: parts[12] ?? '' };
  });
  rows.sort((a, b) => (input.direction === '跌' ? a.pct - b.pct : b.pct - a.pct));
  const limit = Math.min(input.limit ?? 10, 30);
  const lines = rows.slice(0, limit).map((row, index) => {
    const sign = row.pct >= 0 ? '+' : '';
    return `${index + 1}. ${row.name} ${sign}${row.pct.toFixed(2)}%　领涨 ${row.leader}`;
  });
  return `行业板块${input.direction === '跌' ? '跌幅榜' : '涨幅榜'}（新浪，共 ${rows.length} 个）\n${lines.join('\n')}`;
}

async function sectorRankingEastmoney(input: { type?: '行业' | '概念'; limit?: number; direction?: '涨' | '跌' }): Promise<string> {
  const limit = Math.min(input.limit ?? 10, 30);
  const fs = input.type === '概念' ? 'm:90+t:3' : 'm:90+t:2';
  const desc = input.direction === '跌' ? 0 : 1; // po=1 涨幅降序，po=0 升序
  const path =
    `/api/qt/clist/get?pn=1&pz=${limit}&po=${desc}&np=1&fltt=2&invt=2` +
    `&fid=f3&fs=${fs}&fields=f12,f14,f3,f62,f104,f105&ut=b2884a393a59ad64002292a3e90d46a5`;
  const payload = await fetchJsonFromHosts<EastmoneyListResponse>(
    ['push2.eastmoney.com', '82.push2.eastmoney.com', 'push2delay.eastmoney.com'],
    path,
  );
  const rows = payload.data?.diff ?? [];
  if (rows.length === 0) return '没有取到板块数据。';
  const label = input.direction === '跌' ? '跌幅榜' : '涨幅榜';
  const lines = rows.map((row, index) => {
    const name = String(row.f14 ?? '');
    const pct = Number(row.f3 ?? 0);
    const flow = Number(row.f62 ?? 0) / 100000000;
    const sign = pct >= 0 ? '+' : '';
    return `${index + 1}. ${name} ${sign}${pct.toFixed(2)}%　主力净额 ${flow >= 0 ? '+' : ''}${flow.toFixed(2)} 亿`;
  });
  return `${input.type ?? '行业'}板块${label}（共 ${payload.data?.total ?? rows.length} 个）\n${lines.join('\n')}`;
}

interface FundFlowResponse {
  data?: { name?: string; code?: string; klines?: string[] };
}

/** 个股/ETF 主力资金流（最近一日） */
export async function fundFlow(input: { codes: string[] }): Promise<string> {
  const codes = (input.codes ?? []).slice(0, 5);
  if (codes.length === 0) return '请提供 6 位代码。';
  const results: string[] = [];
  for (const code of codes) {
    try {
      const secid = toSecId(code);
      const url =
        `https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=1&klt=101&secid=${secid}` +
        `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
      const payload = await fetchJson<FundFlowResponse>(url);
      const line = payload.data?.klines?.[0];
      if (!line) {
        results.push(`${code}：没有资金流数据`);
        continue;
      }
      // 格式：日期,主力净流入,小单,中单,大单,超大单,...
      const parts = line.split(',');
      const yi = (value: string) => {
        const num = Number(value) / 100000000;
        return `${num >= 0 ? '+' : ''}${num.toFixed(2)} 亿`;
      };
      results.push(
        `${payload.data?.name ?? code}（${parts[0]}）\n` +
          `　主力净流入 ${yi(parts[1])}｜超大单 ${yi(parts[5] ?? '0')}｜大单 ${yi(parts[4] ?? '0')}`,
      );
    } catch (error) {
      results.push(`${code}：${(error as Error).message}`);
    }
  }
  return `资金流（东方财富，T 日收盘口径）\n${results.join('\n')}`;
}

interface NewsResponse {
  LivesList?: Array<{ title?: string; digest?: string; showTime?: string; url_w?: string }>;
}

/** 财经快讯 */
export async function marketNews(input: { limit?: number; keyword?: string }): Promise<string> {
  const limit = Math.min(input.limit ?? 10, 30);
  const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_${limit * 3}_1_.html`;
  const payload = await fetchJson<NewsResponse>(url, 'https://kuaixun.eastmoney.com/');
  let items = payload.LivesList ?? [];
  const keyword = input.keyword?.trim();
  if (keyword) items = items.filter((item) => `${item.title ?? ''}${item.digest ?? ''}`.includes(keyword));
  items = items.slice(0, limit);
  if (items.length === 0) return keyword ? `没有找到包含「${keyword}」的快讯。` : '没有取到快讯。';
  return items
    .map((item) => {
      const time = (item as Record<string, unknown>).showTime ?? (item as Record<string, unknown>).showtime ?? '';
      const title = String(item.title ?? '').replace(/^【[^】]*】/, '');
      const digest = String(item.digest ?? '').replace(/^【[^】]*】/, '').slice(0, 100);
      return `· ${String(time)}　${title}${digest ? `\n  ${digest}` : ''}`;
    })
    .join('\n');
}

/** 主要指数快照（腾讯行情，比东财稳定） */
export async function indexSnapshot(): Promise<string> {
  const indices = [
    ['sh000001', '上证指数'],
    ['sz399001', '深证成指'],
    ['sz399006', '创业板指'],
    ['sh000688', '科创50'],
    ['sh000300', '沪深300'],
    ['sh000905', '中证500'],
  ];
  const query = indices.map(([code]) => code).join(',');
  const text = await fetchGbk(`https://qt.gtimg.cn/q=${query}`);
  const rows = text.split(';').filter((line) => line.includes('~'));
  const out: string[] = [];
  for (const row of rows) {
    const fields = row.split('~');
    if (fields.length < 33) continue;
    const name = fields[1];
    const price = Number(fields[3]);
    const pct = Number(fields[32]);
    const sign = pct >= 0 ? '+' : '';
    out.push(`${name}　${price.toFixed(2)}　${sign}${pct.toFixed(2)}%`);
  }
  return out.length > 0 ? `指数快照（腾讯行情）\n${out.join('\n')}` : '没有取到指数数据。';
}
