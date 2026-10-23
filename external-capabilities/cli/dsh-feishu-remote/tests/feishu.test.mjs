import test from 'node:test';
import assert from 'node:assert/strict';
import { botReady, currentOpenId } from '../src/feishu.mjs';

test('currentOpenId reads the user identity when present', () => {
  assert.equal(currentOpenId({ identities: { user: { openId: 'ou_user' } } }), 'ou_user');
});

test('currentOpenId falls back to a top-level openId', () => {
  assert.equal(currentOpenId({ openId: 'ou_top' }), 'ou_top');
});

test('currentOpenId returns null without a status', () => {
  assert.equal(currentOpenId(null), null);
  assert.equal(currentOpenId({}), null);
});

test('botReady accepts a bot-only machine', () => {
  assert.equal(botReady({ identities: { bot: { status: 'ready' } } }), true);
});

test('botReady ignores a missing or broken bot identity', () => {
  assert.equal(botReady({ identities: { bot: { status: 'missing' } } }), false);
  assert.equal(botReady({ identities: {} }), false);
  assert.equal(botReady(null), false);
});
