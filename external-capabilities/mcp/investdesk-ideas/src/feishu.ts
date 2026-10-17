/**
 * 飞书多维表格极小客户端：只做「想法池」需要的事。
 * 认证走自建应用 tenant_access_token，依赖凭证在 ~/.investdesk/.env。
 */
import { BASE_TOKEN, FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_URL, IDEAS_TABLE } from './config.ts';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const response = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  });
  const payload = (await response.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：${payload.msg}`);
  }
  cachedToken = {
    value: payload.tenant_access_token,
    expiresAt: Date.now() + ((payload.expire ?? 7200) - 300) * 1000,
  };
  return cachedToken.value;
}

async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const response = await fetch(`${FEISHU_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const payload = (await response.json()) as { code: number; msg: string; data?: T };
  if (payload.code !== 0) throw new Error(`飞书接口失败：${payload.msg}`);
  return (payload.data ?? {}) as T;
}

export type IdeaRecord = Record<string, unknown>;

const tablePath = () => `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${IDEAS_TABLE}/records`;

/** 读取记录，可按条件过滤 */
export async function listRecords(params: {
  pageSize?: number;
  filter?: string;
}): Promise<IdeaRecord[]> {
  // 注意：飞书的 sort 参数格式易变（实测 InvalidSort），这里不传，
  // 由调用方在内存里按「时间」倒序排列。
  const query = new URLSearchParams({ page_size: String(params.pageSize ?? 50) });
  if (params.filter) query.set('filter', params.filter);
  const data = await request<{ items?: Array<{ record_id?: string; fields?: Record<string, unknown> }> }>(
    `${tablePath()}?${query}`,
  );
  // OpenAPI 把字段包在 fields 里，这里扁平化，让上层直接读 record.问题
  return (data.items ?? []).map((item) => ({ ...(item.fields ?? {}), record_id: item.record_id ?? '' }));
}

export async function createRecord(fields: Record<string, unknown>): Promise<string> {
  const data = await request<{ record?: { record_id?: string } }>(tablePath(), {
    method: 'POST',
    body: JSON.stringify({ fields }),
  });
  return data.record?.record_id ?? '';
}

export async function updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void> {
  await request(`${tablePath()}/${recordId}`, {
    method: 'PUT',
    body: JSON.stringify({ fields }),
  });
}

/** 取字段文本（兼容数组 / 对象 / 字符串） */
export function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'object' && item && 'text' in item ? String((item as { text: unknown }).text) : textOf(item)))
      .join('');
  }
  if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).text);
  }
  return '';
}
