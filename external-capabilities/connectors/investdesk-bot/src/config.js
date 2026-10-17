import os from 'node:os';
import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export const config = {
  appId: required('FEISHU_APP_ID'),
  appSecret: required('FEISHU_APP_SECRET'),
  deepseekKey: required('DEEPSEEK_API_KEY'),
  deepseekBase: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  dataDir: process.env.BOT_DATA_DIR ?? path.join(process.cwd(), 'data'),
  maxHistory: Number(process.env.BOT_MAX_HISTORY ?? 12),
  baseToken: process.env.INVESTDESK_BASE_TOKEN ?? '',
  ideasTable: process.env.INVESTDESK_IDEAS_TABLE ?? '',
};

export function ensureDataDir() {
  import('node:fs').then(({ mkdirSync }) => mkdirSync(config.dataDir, { recursive: true }));
}
