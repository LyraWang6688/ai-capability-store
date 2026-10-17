/**
 * 场内行情数据源：腾讯 qt.gtimg.cn
 *
 * - 免费、无需 token，一次请求可批量查询约 60 个代码
 * - 返回 GBK 编码，需用 TextDecoder('gbk') 解码
 * - Node 内置 fetch 不读系统代理，这一点比 Python requests 更可控
 */

const ENDPOINT = 'https://qt.gtimg.cn/q=';
const BATCH_SIZE = 60;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ListedQuote {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  changePct: number | null;
  /** yyyyMMddHHmmss */
  tradeTime: string;
}

/** 按 A 股代码规则推断交易所前缀 */
export function guessMarket(code: string): 'sh' | 'sz' | 'bj' {
  if (/^[69]/.test(code)) return 'sh'; // 6=沪主板/科创板, 9=沪B
  if (/^[0123]/.test(code)) return 'sz'; // 0=深主板, 1/2/3=深市基金/创业板
  if (/^[48]/.test(code)) return 'bj'; // 4/8=北交所
  return 'sh';
}

function parseTencentPayload(text: string): ListedQuote[] {
  const out: ListedQuote[] = [];
  for (const line of text.split(';')) {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m) continue;
    const f = m[2].split('~');
    const price = Number(f[3]);
    // 停牌或退市记录会返回 0 / 空，直接丢弃，绝不当成价格写库
    if (!f[1] || !Number.isFinite(price) || price <= 0) continue;
    const pct = Number(f[32]);
    out.push({
      code: f[2],
      name: f[1],
      price,
      prevClose: Number(f[4]),
      changePct: Number.isFinite(pct) ? pct : null,
      tradeTime: f[30] ?? '',
    });
  }
  return out;
}

/**
 * 批量取场内行情。失败会抛错，由调用方决定重试或降级。
 * 注意：同一批里查不到的代码不会出现在返回的 Map 中（不是错误）。
 */
export async function fetchListedQuotes(
  codes: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Map<string, ListedQuote>> {
  const result = new Map<string, ListedQuote>();
  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    const symbols = batch.map((c) => guessMarket(c) + c).join(',');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT + symbols, {
        headers: { Referer: 'https://finance.qq.com' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`腾讯行情 HTTP ${res.status}`);
      const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
      for (const q of parseTencentPayload(text)) result.set(q.code, q);
    } finally {
      clearTimeout(timer);
    }
  }
  return result;
}
