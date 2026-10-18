/** Configuration lives outside any repository: ~/.ai-quote-clip/. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const ROOT = join(HOME, '.ai-quote-clip');
export const CONFIG_PATH = join(ROOT, 'config.json');
export const HOTKEY_CONFIG_PATH = join(ROOT, 'hotkey.json');
export const LOG_DIR = join(ROOT, 'logs');
export const APP_DIR = join(ROOT, 'AiQuoteClip.app');
export const PLIST_LABEL = 'com.lyrawang.ai-quote-clip';
export const PLIST_PATH = join(HOME, 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

export const DEFAULTS = { docToken: '', docUrl: '', larkCli: 'lark-cli', larkProfile: '', title: 'AI 金句' };

export function ensureDirs() {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }; } catch { return null; }
}

export function requireConfig() {
  const cfg = loadConfig();
  if (!cfg || !cfg.docToken) throw new Error(`未初始化：先运行 ai-quote-clip init（配置路径 ${CONFIG_PATH}）`);
  return cfg;
}

export function saveConfig(cfg) {
  ensureDirs();
  const merged = { ...DEFAULTS, ...cfg };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');
  chmodSync(CONFIG_PATH, 0o600);
  return merged;
}
