/**
 * 场外净值数据源：东方财富基金历史净值接口
 *
 * - 免费、无需 token
 * - 公开基金净值与购买平台无关：雪球、支付宝、招商理财买的同一只基金净值相同
 * - QDII 基金净值天然晚 T+1 / T+2，不是数据缺失
 */

const ENDPOINT = 'https://api.fund.eastmoney.com/f10/lsjz';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FundNav {
  code: string;
  /** 单位净值 */
  nav: number;
  /** 净值日期 yyyy-MM-dd */
  date: string;
  changePct: number | null;
}

interface LsjzRow {
  FSRQ?: string;
  DWJZ?: string;
  JZZZL?: string;
}

/**
 * 取单只基金最新净值。查不到返回 null（例如代码不存在），
 * 网络或接口异常则抛错，由调用方重试。
 */
export async function fetchFundNav(
  code: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FundNav | null> {
  const url = `${ENDPOINT}?fundCode=${encodeURIComponent(code)}&pageIndex=1&pageSize=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Referer: 'https://fundf10.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`东财净值 HTTP ${res.status}`);
    const payload = (await res.json()) as { Data?: { LSJZList?: LsjzRow[] } };
    const row = payload.Data?.LSJZList?.[0];
    if (!row?.DWJZ || !row.FSRQ) return null;
    const nav = Number(row.DWJZ);
    if (!Number.isFinite(nav) || nav <= 0) return null;
    const pct = Number(row.JZZZL);
    return {
      code,
      nav,
      date: row.FSRQ,
      changePct: Number.isFinite(pct) ? pct : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
