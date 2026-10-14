/**
 * 本地配置：接入码兑换来的凭证与模型配置。
 *
 * ## 为什么单独放一个文件，而不是让用户填一堆环境变量
 *
 * 改造前用户要在连接器里手工填 5~7 个环境变量，其中还包括我们的模型 key。
 * 换成接入码之后，`teaming setup --code XXXX` 一次换回全部配置写到这里，
 * 用户只需在连接器里保留**启动所需**的两项（command 与 args）——
 * 宿主必须知道怎么拉起进程，这个没法从文件里读。
 *
 * ## 位置与权限
 *
 * 固定 `~/.teaming-mcp/config.json`，权限 0600。
 * 不放在数据目录里：从 git 检出运行时数据目录是仓库本身，
 * 把凭证写进仓库容易被误提交。
 *
 * ## 优先级
 *
 * **环境变量 > 配置文件**。连接器里显式配了就以连接器为准，
 * 这样同一台机器上可以并存多套连接器配置。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_PATH = process.env.TEAMING_CONFIG
  || join(homedir(), '.teaming-mcp', 'config.json');

/**
 * @typedef {object} StoredConfig
 * @property {string} [serverUrl]
 * @property {string} [hostToken]
 * @property {string} [integrationId]
 * @property {string|null} [integrationName]
 * @property {string} [installationId]
 * @property {{apiKey?: string|null, baseUrl?: string|null, model?: string|null}} [analysis]
 * @property {string} [enrolledAt]
 */

/** @returns {StoredConfig|null} */
export function readStoredConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {StoredConfig} config @returns {string} */
export function writeStoredConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);   // 已存在的文件不会被 mode 改到，显式再来一次
  } catch { /* 权限设置失败不阻断 */ }
  return CONFIG_PATH;
}

/**
 * 把配置文件里的值补进 process.env（**不覆盖已有的环境变量**）。
 *
 * 在 MCP 服务与 CLI 启动时各调一次，之后所有模块照旧从 env 读配置，
 * 不需要改动现有代码。
 */
export function applyStoredConfigToEnv() {
  const stored = readStoredConfig();
  if (!stored) return;

  /** @param {string} key @param {string|null|undefined} value */
  const setIfAbsent = (key, value) => {
    if (value && !process.env[key]) process.env[key] = value;
  };

  setIfAbsent('TEAMING_SERVER_URL', stored.serverUrl);
  setIfAbsent('TEAMING_HOST_TOKEN', stored.hostToken);
  setIfAbsent('TEAMING_INTEGRATION_ID', stored.integrationId);
  setIfAbsent('DOUBAO_API_KEY', stored.analysis?.apiKey);
  setIfAbsent('DOUBAO_BASE_URL', stored.analysis?.baseUrl);
  setIfAbsent('DOUBAO_MODEL', stored.analysis?.model);
}

/** 是否已经通过接入码配好了（供 doctor 与 setup 判断）。 */
export function isEnrolled() {
  const stored = readStoredConfig();
  return Boolean(stored?.hostToken && stored?.serverUrl);
}
