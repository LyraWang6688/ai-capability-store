import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK_DIR = process.env.INVESTDESK_HOME ?? path.join(os.homedir(), '.investdesk');

/** 极简 .env 加载：只在变量缺失时补齐，不覆盖已存在的环境变量 */
function loadDotEnv(): void {
  const file = path.join(WORK_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export const FEISHU_BASE_URL = process.env.FEISHU_BASE_URL ?? 'https://open.feishu.cn';
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';
export const BASE_TOKEN = process.env.INVESTDESK_BASE_TOKEN ?? '';
export const IDEAS_TABLE = process.env.INVESTDESK_IDEAS_TABLE ?? '';

export function assertConfigured(): void {
  const missing: string[] = [];
  if (!FEISHU_APP_ID) missing.push('FEISHU_APP_ID');
  if (!FEISHU_APP_SECRET) missing.push('FEISHU_APP_SECRET');
  if (!BASE_TOKEN) missing.push('INVESTDESK_BASE_TOKEN');
  if (!IDEAS_TABLE) missing.push('INVESTDESK_IDEAS_TABLE');
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join(', ')}（配置文件 ${path.join(WORK_DIR, '.env')}）`);
  }
}
