import test from 'node:test';
import assert from 'node:assert/strict';
import { REPLY_KINDS, buildConfirmCard, buildReplyCard } from '../src/cards.mjs';

const EXPECTED_TEMPLATES = {
  ack: 'blue',
  done: 'green',
  error: 'red',
  confirm: 'orange',
  help: 'blue',
  status: 'blue',
};

test('every reply kind builds a schema 2.0 card', () => {
  for (const kind of REPLY_KINDS) {
    const card = buildReplyCard({ kind, text: 'hello' });
    assert.equal(card.schema, '2.0');
    assert.equal(card.header.template, EXPECTED_TEMPLATES[kind]);
    assert.equal(card.header.title.tag, 'plain_text');
    assert.equal(card.header.icon.tag, 'standard_icon');
    assert.equal(card.body.elements[0].tag, 'markdown');
    assert.equal(card.body.elements[0].content, 'hello');
  }
});

test('unknown kind falls back to the done preset', () => {
  const card = buildReplyCard({ kind: 'not-a-kind', text: 'x' });
  assert.equal(card.header.template, 'green');
});

test('title overrides the preset and is bounded', () => {
  const card = buildReplyCard({ kind: 'ack', title: '已取消', text: 'x' });
  assert.equal(card.header.title.content, '已取消');
  const long = buildReplyCard({ kind: 'ack', title: 't'.repeat(200), text: 'x' });
  assert.ok(long.header.title.content.length <= 80);
});

test('body text is truncated to maxChars', () => {
  const card = buildReplyCard({ kind: 'done', text: 'a'.repeat(5000), maxChars: 100 });
  assert.equal(card.body.elements[0].content.length, 100);
});

test('empty body becomes a placeholder', () => {
  const card = buildReplyCard({ kind: 'done', text: '   ' });
  assert.equal(card.body.elements[0].content, '（无内容）');
});

test('meta is rendered as a grey caption after the body', () => {
  const card = buildReplyCard({ kind: 'done', text: 'ok', meta: 'task_1 · 1.2s' });
  assert.equal(card.body.elements.length, 2);
  assert.match(card.body.elements[1].content, /^<font color='grey'>/);
  assert.match(card.body.elements[1].content, /task_1 · 1\.2s/);
  assert.equal(card.body.elements[0].margin, '0px 0px 8px 0px');
});

test('confirm card carries two callback buttons with the task id', () => {
  const card = buildConfirmCard({ text: '删除 /tmp/x', taskId: 'task_1' });
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'orange');
  const row = card.body.elements.find((el) => el.tag === 'column_set');
  assert.ok(row);
  const buttons = row.columns.flatMap((col) => col.elements).filter((el) => el.tag === 'button');
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons[0].behaviors[0], { type: 'callback', value: { action: 'confirm', taskId: 'task_1' } });
  assert.deepEqual(buttons[1].behaviors[0], { type: 'callback', value: { action: 'cancel', taskId: 'task_1' } });
  assert.equal(buttons[0].type, 'primary_filled');
  assert.equal(buttons[1].type, 'default');
});

test('confirm card truncates long text', () => {
  const card = buildConfirmCard({ text: 'x'.repeat(5000), taskId: 't', maxChars: 50 });
  assert.equal(card.body.elements[0].content.length, 50);
});
