/**
 * 模型服务默认值测试。
 *
 * 关注那条最容易踩的规则：**端点与模型必须成对换**。
 * 只换端点的话，引擎会拿上一个服务的模型名去请求新服务，报"模型不存在"——
 * 而报错信息看起来像网络/凭证问题，极难联想到"模型名还是旧的"。
 *
 * 默认值断言必须放在子进程里跑：`applyProviderDefaults()` 有模块级状态
 * （记录端点是不是我们填的默认值），同一进程内先跑一个用例会污染另一个。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'analysis.mjs');

/** 在干净环境里跑一小段脚本，返回它的 stdout */
function inCleanEnv(code, env = {}) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  }).trim();
}

test('★ 什么都不配时，端点与模型都给默认值（不能只给端点）', () => {
  const out = inCleanEnv(`
    const m = await import(${JSON.stringify(CLI)});
    m.applyProviderDefaults();
    console.log(JSON.stringify(m.providerSummary()));
  `);
  const p = JSON.parse(out);
  assert.equal(p.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(p.model, 'deepseek-flash', '模型必须一起给默认值，否则会拿旧模型名请求新端点');
  assert.equal(p.baseUrlIsDefault, true, '默认端点不该被报成显式配置');
});

test('显式配置不被覆盖，也不标记为默认', () => {
  const out = inCleanEnv(`
    const m = await import(${JSON.stringify(CLI)});
    m.applyProviderDefaults();
    console.log(JSON.stringify(m.providerSummary()));
  `, { DOUBAO_BASE_URL: 'https://custom.example/v1', DOUBAO_MODEL: 'custom-model' });
  const p = JSON.parse(out);
  assert.equal(p.baseUrl, 'https://custom.example/v1');
  assert.equal(p.model, 'custom-model');
  assert.equal(p.baseUrlIsDefault, false);
});

test('LLM_* 优先于 DOUBAO_*（用于换服务时不改历史变量名）', () => {
  const out = inCleanEnv(`
    const m = await import(${JSON.stringify(CLI)});
    m.applyProviderDefaults();
    console.log(JSON.stringify(m.providerSummary()));
  `, {
    LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'k',
    DOUBAO_BASE_URL: 'https://doubao.example/v3',
  });
  assert.equal(JSON.parse(out).baseUrl, 'https://llm.example/v1');
});

test('只配了模型没配端点：模型保留，端点补默认', () => {
  const out = inCleanEnv(`
    const m = await import(${JSON.stringify(CLI)});
    m.applyProviderDefaults();
    console.log(JSON.stringify(m.providerSummary()));
  `, { ANALYSIS_MODEL: 'my-model' });
  const p = JSON.parse(out);
  assert.equal(p.model, 'my-model');
  assert.equal(p.baseUrl, 'https://api.deepseek.com/v1');
});

test('缺凭证时 analysisReadiness 报出来，且指出下一步', async () => {
  const out = inCleanEnv(`
    const m = await import(${JSON.stringify(CLI)});
    console.log(JSON.stringify(m.analysisReadiness().problems));
  `);
  const problems = JSON.parse(out);
  const cred = problems.find((p) => p.includes('凭证'));
  if (cred) assert.match(cred, /下一步/, '报错要给出下一步，而不只是说缺什么');
});
