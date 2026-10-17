/**
 * CLI 入口行为测试。
 *
 * 覆盖两件用户会直接撞上的事：
 *
 *  1. **退出码**。主动查帮助（无参数 / --help / help）不该返回失败退出码——
 *     否则在脚本或 CI 里会被当成错误。曾经 --help 和未知命令都退出 1。
 *  2. **帮助里必须有 setup**。安装指南让新用户跑的第一条命令就是
 *     `teaming setup --code`；帮助里没有它，用户会以为命令不存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.mjs');
const ROOT = join(import.meta.dirname, '..');

function runCli(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

test('无参数时打印用法并退出 0（不是失败）', () => {
  const r = runCli([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /会议动力分析 CLI/);
});

test('--help / -h / help 都退出 0', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const r = runCli([flag]);
    assert.equal(r.code, 0, `${flag} 应退出 0，实际 ${r.code}`);
  }
});

test('未知命令退出 1（这才是调用出错）', () => {
  assert.equal(runCli(['definitely-not-a-command']).code, 1);
});

test('★ 帮助里必须列出 setup（新用户的第一条命令）', () => {
  assert.match(runCli(['--help']).out, /teaming setup --code/);
});

test('--version 输出版本号，且与 package.json 一致', () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const r = runCli(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), version);
});

test('帮助里说明分析在服务器跑，本机不需要模型配置', () => {
  const out = runCli(['--help']).out;
  // 2026-10-15 起分析由服务器完成。帮助里若还提 deepseek/API key，
  // 会让人以为"本机也要配模型"，从而照着一个不存在的步骤去做。
  assert.match(out, /服务器/, '应写清分析在服务器侧完成');
  assert.ok(!/DOUBAO_API_KEY|LLM_API_KEY/.test(out), '不该再让用户配本机模型凭证');
});
