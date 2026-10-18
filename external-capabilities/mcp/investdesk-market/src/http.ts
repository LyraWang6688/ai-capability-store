/**
 * 带重试的抓取工具。
 *
 * 东方财富的公开接口不稳定：实测同一 URL 有时正常、有时直接关连接
 * （RemoteDisconnected）。所以统一走「3 次重试 + 短退避」，并在全部失败时
 * 抛出可读错误，让上层明确告诉用户「数据源暂不可用」而不是编造数据。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export async function fetchText(url: string, referer = 'https://quote.eastmoney.com/'): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text.trim()) throw new Error('空响应');
      return text;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error(`数据源不可用（已重试 3 次）：${(lastError as Error)?.message ?? '未知错误'}`);
}

/**
 * 抓取 GBK 编码页面（腾讯行情返回 GBK，直接当 UTF-8 解码会乱码）。
 * Node 的 TextDecoder 需要完整 ICU 才支持 gbk；不支持时退回 latin1 并提示。
 */
export async function fetchGbk(url: string, referer = 'https://gu.qq.com/'): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      try {
        return new TextDecoder('gbk').decode(buffer);
      } catch {
        return Buffer.from(buffer).toString('latin1');
      }
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw new Error(`数据源不可用（已重试 3 次）：${(lastError as Error)?.message ?? '未知错误'}`);
}

/** 依次尝试多个镜像域名，全部失败才抛错 */
export async function fetchJsonFromHosts<T>(hosts: string[], path: string, referer?: string): Promise<T> {
  let lastError: unknown;
  for (const host of hosts) {
    try {
      return await fetchJson<T>(`https://${host}${path}`, referer);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function fetchJson<T>(url: string, referer?: string): Promise<T> {
  const text = await fetchText(url, referer);
  // 东财部分接口返回 JSONP：var ajaxResult={...};
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const body = start >= 0 ? text.slice(start, end + 1) : text;
  return JSON.parse(body) as T;
}

/** 6 位代码 → 东财 secid（1=沪市 / 0=深市） */
export function toSecId(code: string): string {
  const clean = code.replace(/\D/g, '');
  const market = /^(5|6|9|11|13|50|51|52|56|58)/.test(clean) ? '1' : '0';
  return `${market}.${clean}`;
}

/** 6 位代码 → 腾讯行情代码（sh/sz） */
export function toTencentCode(code: string): string {
  const clean = code.replace(/\D/g, '');
  const prefix = /^(5|6|9|11|13|50|51|52|56|58)/.test(clean) ? 'sh' : 'sz';
  return `${prefix}${clean}`;
}
