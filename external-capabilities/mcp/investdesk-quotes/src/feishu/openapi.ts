/**
 * 飞书 OpenAPI 后端 —— 用自建应用的 tenant_access_token 直接调接口。
 *
 * 相比 lark-cli 后端，它不依赖本机 keychain，因此可以在云端 / CI / 定时函数里跑。
 * 代价是需要一次性配置：
 *   1. 在飞书开发者后台创建自建应用，拿到 app_id / app_secret
 *   2. 开通多维表格权限（bitable:app 或对应的记录读写 scope）
 *   3. 把该应用添加为这个 Base 的协作者（可编辑）
 *
 * 权限没配好时，飞书会返回 91403 / 1254302 之类的错误，提示里会说明缺什么。
 */

import type { FeishuBackend, RawRecord } from './backend.ts';

const DEFAULT_BASE_URL = 'https://open.feishu.cn';

interface TokenCache {
  token: string;
  expiresAt: number;
}

export interface OpenApiOptions {
  appId: string;
  appSecret: string;
  appToken: string;
  baseUrl?: string;
}

export class OpenApiBackend implements FeishuBackend {
  readonly name = 'openapi';
  private readonly options: OpenApiOptions;
  private tokenCache: TokenCache | null = null;

  constructor(options: OpenApiOptions) {
    this.options = options;
  }

  private get baseUrl(): string {
    return this.options.baseUrl ?? DEFAULT_BASE_URL;
  }

  /** 换取 tenant_access_token，带内存缓存（提前 5 分钟过期） */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) return this.tokenCache.token;

    const response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
    });
    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(
        `获取 tenant_access_token 失败（code=${payload.code}）：${payload.msg ?? 'unknown'}。` +
          '请确认 app_id / app_secret 正确，且应用已开通权限。',
      );
    }
    const ttlMs = Math.max(60, (payload.expire ?? 7200) - 300) * 1000;
    this.tokenCache = { token: payload.tenant_access_token, expiresAt: now + ttlMs };
    return this.tokenCache.token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        ...(init.headers ?? {}),
      },
    });
    const payload = (await response.json()) as { code?: number; msg?: string; data?: T };
    if (payload.code !== 0) {
      throw new Error(`飞书接口失败 ${path}（code=${payload.code}）：${payload.msg ?? 'unknown'}`);
    }
    return payload.data as T;
  }

  async listRecords(tableId: string, limit: number): Promise<RawRecord[]> {
    const records: RawRecord[] = [];
    let pageToken = '';
    for (;;) {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const data = await this.request<{
        items?: RawRecord[];
        has_more?: boolean;
        page_token?: string;
      }>(`/open-apis/bitable/v1/apps/${this.options.appToken}/tables/${tableId}/records?${query}`);

      for (const item of data.items ?? []) records.push(item);
      if (records.length >= limit || !data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return records.slice(0, limit);
  }

  async batchUpdateRecords(
    tableId: string,
    updates: Array<{ recordId: string; fields: Record<string, unknown> }>,
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const CHUNK = 200;
    let written = 0;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await this.request(
        `/open-apis/bitable/v1/apps/${this.options.appToken}/tables/${tableId}/records/batch_update`,
        {
          method: 'POST',
          body: JSON.stringify({
            records: chunk.map((update) => ({ record_id: update.recordId, fields: update.fields })),
          }),
        },
      );
      written += chunk.length;
    }
    return written;
  }
}
