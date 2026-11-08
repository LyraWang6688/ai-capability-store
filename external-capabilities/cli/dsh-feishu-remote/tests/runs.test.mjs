import test from 'node:test';
import assert from 'node:assert/strict';

import { isCompleted, parseEvents } from '../src/listener.mjs';

function ndjson(...events) {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

test('parseEvents reads session id, final text and the durable reason', () => {
  const stdout = ndjson(
    { type: 'session', sessionId: 'session-abc' },
    { type: 'text', text: '中间输出' },
    { type: 'final', text: '最终回答', reason: { kind: 'completed' } },
  );
  const parsed = parseEvents(stdout);
  assert.equal(parsed.sessionId, 'session-abc');
  assert.equal(parsed.reply, '最终回答');
  assert.deepEqual(parsed.reason, { kind: 'completed' });
});

test('parseEvents keeps working with a final event that has no reason (0.2.1)', () => {
  const parsed = parseEvents(ndjson({ type: 'final', text: '老版本回答' }));
  assert.equal(parsed.reply, '老版本回答');
  assert.equal(parsed.reason, null);
});

test('parseEvents tolerates a null reason and bad lines', () => {
  const parsed = parseEvents(`not json\n${ndjson({ type: 'final', text: 'ok', reason: null })}`);
  assert.equal(parsed.reply, 'ok');
  assert.equal(parsed.reason, null);
});

test('isCompleted requires exit 0 and, when reported, reason.kind completed', () => {
  assert.equal(isCompleted({ code: 0 }), true);
  assert.equal(isCompleted({ code: 0, reason: null }), true);
  assert.equal(isCompleted({ code: 0, reason: { kind: 'completed' } }), true);
  assert.equal(isCompleted({ code: 0, reason: { kind: 'aborted' } }), false);
  assert.equal(isCompleted({ code: 0, reason: { kind: 'error' } }), false);
});

test('isCompleted keeps failing runs failing', () => {
  assert.equal(isCompleted({ code: 1, reason: { kind: 'completed' } }), false);
  assert.equal(isCompleted({ code: 'timeout' }), false);
  assert.equal(isCompleted(null), false);
  assert.equal(isCompleted({}), false);
});

test('isCompleted ignores a malformed reason object', () => {
  assert.equal(isCompleted({ code: 0, reason: {} }), true);
  assert.equal(isCompleted({ code: 0, reason: 'completed' }), true);
});
