#!/usr/bin/env node
/**
 * deepseek-invoice 纯逻辑的单测（不启动浏览器、不读配置）。
 *
 * 运行：node --test automations/deepseek-invoice/test_lib.mjs
 *
 * 为什么要有这组测试：这个自动化有两个"静默报成功"的失败分支 ——
 * 金额读不到被当成 0 跳过、提交未验证只 emit 一句然后退出码 0。
 * 把判定逻辑拆到 lib.mjs 之后，这两个分支可以在 CI 里被固定住，
 * 而不是等下一次月度执行（或者永远）才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_CODES, parseAvailableAmount } from './lib.mjs';

test('读不到金额 → unreadable，而不是"0"', () => {
  const raws = [null, undefined, '', '   ', '¥--', '¥1.2.3.4'];
  for (const raw of raws) {
    const r = parseAvailableAmount(raw);
    assert.equal(r.kind, 'unreadable', `raw=${JSON.stringify(raw)}`);
    assert.equal(r.value, null, `raw=${JSON.stringify(raw)}`);
  }
});

test('明确读到 0 → zero（本月已开完，可以跳过）', () => {
  for (const raw of ['¥0.00', '￥0', '¥ 0.0']) {
    const r = parseAvailableAmount(raw);
    assert.equal(r.kind, 'zero', `raw=${JSON.stringify(raw)}`);
    assert.equal(r.value, 0);
  }
});

test('有额度 → positive，千分位与符号被剥掉', () => {
  assert.deepEqual(parseAvailableAmount('¥1,234.56'),
    { kind: 'positive', value: 1234.56, raw: '¥1,234.56' });
  assert.equal(parseAvailableAmount('￥200').value, 200);
  assert.equal(parseAvailableAmount('¥ 1,234').kind, 'positive');
});

test('两个失败分支的退出码非 0、互不相同、且不等于"成功"', () => {
  assert.notEqual(EXIT_CODES.OK, EXIT_CODES.AMOUNT_UNREADABLE);
  assert.notEqual(EXIT_CODES.OK, EXIT_CODES.SUBMIT_UNVERIFIED);
  assert.notEqual(EXIT_CODES.AMOUNT_UNREADABLE, EXIT_CODES.SUBMIT_UNVERIFIED);
  for (const code of [EXIT_CODES.AMOUNT_UNREADABLE, EXIT_CODES.SUBMIT_UNVERIFIED]) {
    assert.ok(Number.isInteger(code) && code > 0, `code=${code}`);
  }
});
