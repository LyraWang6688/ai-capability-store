/**
 * 回归测试：`needs_refresh` 不等于「未授权」。
 *
 * 2026-10-14 在豆包工作里实测连接器时踩到：
 * 终端 `lark-cli auth status` 显示用户名、scope、refresh 有效期全部正常，
 * 但 `teaming_doctor` 报「飞书未授权」，并建议去重新登录——**建议是错的**。
 *
 * 原因：lark-cli 对"访问令牌过期、refresh token 有效"报的是 `needs_refresh`，
 * 含义是**下一次调用会自动刷新**，属于正常状态；而判定代码只认 `ready`。
 * 更糟的是这条规则存在**两份副本**（lark.mjs 与 cli.mjs），两份都错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isLarkUserUsable, readLarkIdentity } from '../src/readiness.mjs';

const SCOPE_OK = 'vc:meeting.search:read minutes:minutes:readonly auth:user.id:read';

test('status=ready → 可用', () => {
  assert.equal(isLarkUserUsable({ status: 'ready', userName: '王颖', scope: SCOPE_OK }), true);
});

test('★ status=needs_refresh → 仍可用（令牌会自动刷新）', () => {
  assert.equal(
    isLarkUserUsable({ status: 'needs_refresh', available: true, userName: '王颖', openId: 'ou_x' }),
    true,
    'needs_refresh 是正常状态，不该判成未授权'
  );
});

test('needs_refresh 且能读出用户名与 scope', () => {
  const r = readLarkIdentity({
    identities: { user: { status: 'needs_refresh', available: true, userName: '王颖', scope: SCOPE_OK } },
  });
  assert.equal(r.userName, '王颖');
  assert.match(r.scopes, /vc:meeting.search:read/);
});

test('确实未授权 → 不可用', () => {
  assert.equal(isLarkUserUsable({ status: 'unauthenticated' }), false);
  assert.equal(isLarkUserUsable({ status: 'needs_refresh', available: false }), false);
  assert.equal(isLarkUserUsable(undefined), false);
  assert.equal(isLarkUserUsable(null), false);
});

test('有状态但没有身份标识 → 仍不可用', () => {
  assert.equal(isLarkUserUsable({ status: 'ready' }), false);
});

test('只有 openId、没有 userName → 可用（用 openId 兜底）', () => {
  const r = readLarkIdentity({
    identities: { user: { status: 'needs_refresh', available: true, openId: 'ou_x' } },
  });
  assert.equal(r.userName, 'ou_x');
});

/** 剥掉 // 与 /* *\/ 注释，避免注释里的历史说明被当成代码。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('★ 判定只有一份：cli.mjs 不得自己再判 status', () => {
  const code = stripComments(readFileSync('src/cli.mjs', 'utf8'));
  assert.ok(!/status\s*===\s*'ready'/.test(code), 'cli.mjs 应复用 larkReadiness()，不得自己再判一遍');
  assert.match(code, /larkReadiness\(\)/, 'cli.mjs 应调用 larkReadiness()');
});

test('★ 判定只有一份：lark.mjs 复用 readiness 纯函数', () => {
  const code = stripComments(readFileSync('src/lark.mjs', 'utf8'));
  assert.ok(!/status\s*===\s*'ready'/.test(code), 'lark.mjs 不得内联 status 判定');
  assert.match(code, /readLarkIdentity/, 'lark.mjs 应复用 readLarkIdentity()');
});
