/**
 * 运行时配置。
 *
 * 遵循 Store 里 launchd 类自动化的既有约定：**代码在 Store 检出目录，
 * 状态（.env / 缓存 / 对账单）在工作目录**，两者独立。
 *
 * 工作目录默认 ~/.investdesk，可用 INVESTDESK_HOME 覆盖。
 * 这样代码可以随 Store 更新，而个人凭证与数据留在本机工作目录里。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 工作目录：存放 .env、.cache、inbox，不随代码仓库移动 */
export const WORK_DIR = process.env.INVESTDESK_HOME ?? path.join(os.homedir(), '.investdesk');

export const CACHE_DIR = path.join(WORK_DIR, '.cache');
export const INBOX_DIR = path.join(WORK_DIR, 'inbox');

/** 极简 .env 解析：不做变量展开，够用即可 */
function loadDotEnv(): void {
  const file = path.join(WORK_DIR, '.env');
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv();
mkdirSync(WORK_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

/** 飞书多维表格坐标。换库时用环境变量覆盖。 */
export const BASE_TOKEN = process.env.INVESTDESK_BASE_TOKEN ?? '';
export const HOLDINGS_TABLE = process.env.INVESTDESK_HOLDINGS_TABLE ?? '';
export const PLATFORMS_TABLE = process.env.INVESTDESK_PLATFORMS_TABLE ?? '';

/** MCP 服务端口 */
export const MCP_PORT = Number(process.env.MCP_PORT ?? 8787);

/**
 * 飞书自建应用凭据。
 *
 * 0.3.0 起这是**唯一**的认证方式：用 tenant_access_token 调 OpenAPI，
 * 不依赖任何本机凭据，本机与云端行为一致。
 */
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';
export const FEISHU_BASE_URL = process.env.FEISHU_BASE_URL ?? 'https://open.feishu.cn';

export function assertFeishuConfigured(): void {
  const missing: string[] = [];
  if (!FEISHU_APP_ID) missing.push('FEISHU_APP_ID');
  if (!FEISHU_APP_SECRET) missing.push('FEISHU_APP_SECRET');
  if (!BASE_TOKEN) missing.push('INVESTDESK_BASE_TOKEN');
  if (!HOLDINGS_TABLE) missing.push('INVESTDESK_HOLDINGS_TABLE');
  if (missing.length > 0) {
    throw new Error(
      `缺少飞书配置：${missing.join(', ')}。请在 ${path.join(WORK_DIR, '.env')} 中补齐。`,
    );
  }
}
