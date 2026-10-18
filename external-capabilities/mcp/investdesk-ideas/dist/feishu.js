/**
 * 飞书多维表格极小客户端：只做「想法池」需要的事。
 * 认证走自建应用 tenant_access_token，依赖凭证在 ~/.investdesk/.env。
 */
import { BASE_TOKEN, FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_BASE_URL, IDEAS_TABLE, WATCH_TABLE } from './config.js';
let cachedToken = null;
async function getToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now())
        return cachedToken.value;
    const response = await fetch(`${FEISHU_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
    });
    const payload = (await response.json());
    if (payload.code !== 0 || !payload.tenant_access_token) {
        throw new Error(`获取 tenant_access_token 失败：${payload.msg}`);
    }
    cachedToken = {
        value: payload.tenant_access_token,
        expiresAt: Date.now() + ((payload.expire ?? 7200) - 300) * 1000,
    };
    return cachedToken.value;
}
async function request(pathname, init = {}) {
    const token = await getToken();
    const response = await fetch(`${FEISHU_BASE_URL}${pathname}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
        },
    });
    const payload = (await response.json());
    if (payload.code !== 0)
        throw new Error(`飞书接口失败：${payload.msg}`);
    return (payload.data ?? {});
}
/** 表名 → table_id */
export const TABLES = {
    ideas: IDEAS_TABLE,
    watch: WATCH_TABLE,
};
const tablePath = (table = 'ideas') => `/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLES[table] ?? table}/records`;
/**
 * 读取记录。
 *
 * - 不带条件：GET /records（分页列表）
 * - 带条件：POST /records/search（GET 接口的 filter 参数不被识别，会报 InvalidFilter）
 *
 * 注意：sort 参数实测报 InvalidSort，这里不传，由调用方在内存排序。
 */
export async function listRecords(params) {
    const pageSize = params.pageSize ?? 50;
    const path = tablePath(params.table);
    const data = params.filter
        ? await request(`${path}/search`, {
            method: 'POST',
            body: JSON.stringify({ filter: params.filter, automatic_fields: false, page_size: pageSize }),
        })
        : await request(`${path}?page_size=${pageSize}`);
    // OpenAPI 把字段包在 fields 里，这里扁平化，让上层直接读 record.问题
    return (data.items ?? []).map((item) => ({ ...(item.fields ?? {}), record_id: item.record_id ?? '' }));
}
export async function createRecord(fields, table = 'ideas') {
    const data = await request(tablePath(table), {
        method: 'POST',
        body: JSON.stringify({ fields }),
    });
    return data.record?.record_id ?? '';
}
export async function updateRecord(recordId, fields, table = 'ideas') {
    await request(`${tablePath(table)}/${recordId}`, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
    });
}
/** 按 record_id 取单条记录（已扁平化字段） */
export async function getRecord(recordId, table = 'ideas') {
    const data = await request(`${tablePath(table)}/${recordId}`);
    if (!data.record)
        return null;
    return { ...(data.record.fields ?? {}), record_id: data.record.record_id ?? recordId };
}
/** 取字段文本（兼容数组 / 对象 / 字符串） */
export function textOf(value) {
    if (value == null)
        return '';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return String(value);
    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'object' && item && 'text' in item ? String(item.text) : textOf(item)))
            .join('');
    }
    if (typeof value === 'object' && 'text' in value) {
        return String(value.text);
    }
    return '';
}
