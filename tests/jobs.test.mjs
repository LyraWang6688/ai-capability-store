/**
 * 后台任务账本自测 —— 纯文件操作，不联网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 之前设好，jobs.mjs 在模块加载时读取该变量
process.env.TEAMING_JOBS = mkdtempSync(join(tmpdir(), 'teaming-jobs-'));

const { newJobId, writeJob, readJob, listJobs, waitForJob } = await import('../src/jobs.mjs');

test('job_id 形状稳定且唯一', () => {
  const a = newJobId(); const b = newJobId();
  assert.match(a, /^job-[0-9a-zA-Z-]+$/);
  assert.notEqual(a, b);
});

test('写入后可读回，且 patch 是合并而非覆盖', () => {
  const id = newJobId();
  writeJob(id, { status: 'running', meetingId: 'm1' });
  writeJob(id, { status: 'done', zone: '学习区' });
  const j = readJob(id);
  assert.equal(j.status, 'done');
  assert.equal(j.zone, '学习区');
  assert.equal(j.meetingId, 'm1', '先写的字段不应被覆盖掉');
  assert.ok(j.updatedAt, '应自动补 updatedAt');
});

test('读不存在的 job 返回 null，不抛错', () => {
  assert.equal(readJob(newJobId()), null);
});

test('非法 job_id 被拒绝（防路径穿越）', () => {
  for (const bad of ['../etc/passwd', 'job-../../x', 'x', '']) {
    assert.throws(() => readJob(bad), /非法 job_id/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('waitForJob 在终态立即返回', async () => {
  const id = newJobId();
  writeJob(id, { status: 'done', zone: '舒适区' });
  const j = await waitForJob(id, 1000, 20);
  assert.equal(j.status, 'done');
});

test('waitForJob 超时返回 running 现场，不算失败', async () => {
  const id = newJobId();
  writeJob(id, { status: 'running' });
  const j = await waitForJob(id, 150, 30);
  assert.equal(j.status, 'running', '超时应原样返回，交由调用方决定是否轮询');
});

test('listJobs 按更新时间倒序', async () => {
  const a = newJobId(); const b = newJobId();
  writeJob(a, { status: 'done' });
  await new Promise((r) => setTimeout(r, 20));
  writeJob(b, { status: 'done' });
  const list = listJobs(5);
  assert.equal(list[0].jobId, b, '最近写入的应排在最前');
});
