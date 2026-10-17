/**
 * 本机配置（接入码换来的）测试。
 *
 * 关注两件事：
 *  1. 配置文件能补齐环境变量，但**不覆盖**已显式设置的那份（连接器优先）；
 *  2. isEnrolled() 的判据——doctor 靠它决定要不要把飞书三项标成"不需要"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'teaming-config-'));
process.env.TEAMING_CONFIG = join(DIR, 'config.json');

const { readStoredConfig, writeStoredConfig, applyStoredConfigToEnv, isEnrolled, CONFIG_PATH } =
  await import('../src/config.mjs');

const FULL = {
  serverUrl: 'https://example.test',
  hostToken: 'tmh_test',
  integrationId: '11111111-2222-3333-4444-555555555555',
  analysis: { apiKey: 'key-1', baseUrl: 'https://ark.example/api/v3', model: 'ep-test' },
};

test('配置文件位置可由 TEAMING_CONFIG 覆盖（测试不碰真实家目录）', () => {
  assert.equal(CONFIG_PATH, join(DIR, 'config.json'));
});

test('写进去的配置权限是 0600（含凭证与 key）', () => {
  writeStoredConfig(FULL);
  const mode = statSync(CONFIG_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);
});

test('读回的字段与写入一致', () => {
  const got = readStoredConfig();
  assert.equal(got.hostToken, 'tmh_test');
  assert.equal(got.analysis.model, 'ep-test');
});

test('★ 配置文件补齐环境变量，但不覆盖已显式设置的', () => {
  const before = process.env.TEAMING_SERVER_URL;
  process.env.TEAMING_SERVER_URL = 'https://from-connector.test';   // 连接器里显式配的
  try {
    applyStoredConfigToEnv();
    assert.equal(process.env.TEAMING_SERVER_URL, 'https://from-connector.test', '不该覆盖连接器里的值');
  } finally {
    if (before === undefined) delete process.env.TEAMING_SERVER_URL;
    else process.env.TEAMING_SERVER_URL = before;
  }
});

test('★ 不再往环境里注入模型配置（分析在服务器跑，注入了反而误导）', () => {
  for (const k of ['DOUBAO_MODEL', 'DOUBAO_API_KEY', 'DOUBAO_BASE_URL']) delete process.env[k];
  applyStoredConfigToEnv();
  // 旧行为会从 config.json 里把服务器下发的 model/baseUrl 写进 env，
  // 让人以为"本机配了模型"。现在分析在服务器侧，本机不需要这些。
  for (const k of ['DOUBAO_MODEL', 'DOUBAO_API_KEY', 'DOUBAO_BASE_URL']) {
    assert.equal(process.env[k], undefined, `${k} 不该被注入`);
  }
});

test('isEnrolled 需要同时有 hostToken 与 serverUrl', () => {
  assert.equal(isEnrolled(), true);
  writeStoredConfig({ serverUrl: 'https://example.test' });   // 缺 hostToken
  assert.equal(isEnrolled(), false);
  writeStoredConfig({ hostToken: 'tmh_test' });               // 缺 serverUrl
  assert.equal(isEnrolled(), false);
});

test('配置不存在时读取返回 null，不抛错', () => {
  const p = CONFIG_PATH;
  rmSync(p, { force: true });
  assert.equal(readStoredConfig(), null);
  assert.equal(isEnrolled(), false);
});

test('配置文件损坏时不抛错（坏 JSON 也只是没有配置）', () => {
  writeFileSync(CONFIG_PATH, '{ 这不是 JSON');
  assert.equal(readStoredConfig(), null);
});

test.after(() => rmSync(DIR, { recursive: true, force: true }));
