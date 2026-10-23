/**
 * Configuration: lives OUTSIDE any repository, in ~/.dsh-feishu-remote.
 * Nothing here is ever committed; credentials stay in lark-cli / keychain.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const ROOT_DIR = process.env.DSH_FEISHU_REMOTE_HOME || join(HOME, '.dsh-feishu-remote');
export const CONFIG_PATH = join(ROOT_DIR, 'config.json');
export const LOG_DIR = join(ROOT_DIR, 'logs');
export const STATE_PATH = join(ROOT_DIR, 'state.json');
export const ENV_FILE = join(ROOT_DIR, 'env');
export const SERVICE_SCRIPT = join(ROOT_DIR, 'service.sh');
export const PLIST_LABEL = 'com.lyrawang.dsh-feishu-remote';

export const HIGH_RISK_DEFAULT = [
  'rm -rf', 'sudo rm', '删除', '格式化', '清空', '抹掉',
  '转账', '支付', '打款', '退款', '群发',
  'drop table', 'git push --force', 'reset --hard',
];

export const DEFAULTS = {
  larkCli: 'lark-cli',
  larkProfile: '',
  dshCli: 'dsh',
  agentArgs: ['headless'],
  workdir: HOME,
  timeoutSeconds: 300,
  reuseSession: true,
  cardActions: false,
  maxReplyChars: 3500,
  allowedOpenIds: [],
  allowedChatTypes: ['p2p'],
  highRiskPatterns: HIGH_RISK_DEFAULT,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  keychainService: 'DEEPSEEK_API_KEY',
  extraEnv: {},
};

export function ensureDirs() {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return { ...DEFAULTS, ...raw };
}

export function requireConfig() {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error(`未找到配置：${CONFIG_PATH}\n先运行：dsh-feishu-remote init`);
  }
  if (!Array.isArray(cfg.allowedOpenIds) || cfg.allowedOpenIds.length === 0) {
    throw new Error('allowedOpenIds 为空：至少要允许一个发送人（自己的 open_id）');
  }
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  const merged = { ...DEFAULTS, ...cfg };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  chmodSync(CONFIG_PATH, 0o600);
  return merged;
}
