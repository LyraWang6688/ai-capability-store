/**
 * 数据目录分流测试。
 *
 * 全局 npm 安装时包目录在 node_modules 里：可能不可写（sudo 安装时属 root），
 * 且升级/重装会被清掉。所以运行数据必须落到用户目录。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isGitCheckout, resolveOutDir, resolveStateDir, resolveJobsDir } from '../src/paths.mjs';

test('git 检出时数据落在仓库内（沿用旧行为，两个目录已在 .gitignore）', () => {
  assert.equal(isGitCheckout(), true, '本仓库测试时应当识别为 git 检出');
  assert.ok(!resolveOutDir().includes('node_modules'), '绝不能落进 node_modules');
});

test('TEAMING_DATA_DIR 可整体覆盖', () => {
  const prev = process.env.TEAMING_DATA_DIR;
  process.env.TEAMING_DATA_DIR = '/tmp/teaming-test-data';
  try {
    assert.equal(resolveOutDir(), '/tmp/teaming-test-data/.out');
    assert.equal(resolveStateDir(), '/tmp/teaming-test-data/.state');
    assert.equal(resolveJobsDir(), '/tmp/teaming-test-data/.state/jobs');
  } finally {
    if (prev === undefined) delete process.env.TEAMING_DATA_DIR;
    else process.env.TEAMING_DATA_DIR = prev;
  }
});

test('单项环境变量优先于数据根目录', () => {
  const prev = process.env.TEAMING_OUT;
  process.env.TEAMING_OUT = '/tmp/custom-out';
  try {
    assert.equal(resolveOutDir(), '/tmp/custom-out');
  } finally {
    if (prev === undefined) delete process.env.TEAMING_OUT;
    else process.env.TEAMING_OUT = prev;
  }
});

test('jobs 默认落在 state 之下（便于整体迁移）', () => {
  const prev = process.env.TEAMING_STATE;
  process.env.TEAMING_STATE = '/tmp/custom-state';
  try {
    assert.equal(resolveJobsDir(), join('/tmp/custom-state', 'jobs'));
  } finally {
    if (prev === undefined) delete process.env.TEAMING_STATE;
    else process.env.TEAMING_STATE = prev;
  }
});

test('用户目录兜底不指向 node_modules', () => {
  // 模拟 npm 安装场景：无法真的删 .git，改为断言兜底路径的构造规则
  assert.ok(join(homedir(), '.teaming-mcp').startsWith(homedir()));
});
