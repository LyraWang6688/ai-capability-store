/**
 * 逐字稿取数回归测试 —— 用假 lark-cli，不联网。
 *
 * 产品规则（对齐 teaming-bot）：**只认妙记的文字转录稿**。
 * 不做智能纪要 fallback，也不用 AI 摘要替代。
 * 这个文件同时锁住取数参数——那三个坑曾经让妙记路径整个走不通。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'helpers', 'fake-lark-cli.mjs');
chmodSync(FAKE, 0o755);

// lark.mjs 在模块加载时读取 LARK_CLI，必须先设环境变量再动态 import
process.env.LARK_CLI = FAKE;
process.env.FAKE_LARK_MODE = 'minute-ok';
const { fetchTranscript } = await import('../src/lark.mjs');

test('妙记路径：参数正确时能拿到转录稿', () => {
  const t = fetchTranscript({ minuteToken: 'tok-abc', topic: '假会议' });
  assert.match(t, /甲 00:00:53\.530/);
  assert.match(t, /乙 00:00:55\.150/);
});

test('妙记导出的格式正是引擎能直接解析的（姓名 + 时间戳）', () => {
  const t = fetchTranscript({ minuteToken: 'tok-abc', topic: '假会议' });
  const speakerLines = t.split('\n').filter((l) => /^.{1,48}?\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*/.test(l));
  assert.ok(speakerLines.length >= 2, `应识别出说话人行，实际 ${speakerLines.length}`);
});

test('没有妙记时直接说清楚，并且不接受任何替代产物', () => {
  try {
    fetchTranscript({ topic: '没录制的会' });
    assert.fail('应该抛错');
  } catch (e) {
    assert.match(e.message, /没有妙记/);
    assert.match(e.message, /只认妙记/, '必须写明只认妙记，防止有人加回 AI 摘要 fallback');
    assert.equal(e.kind, 'no_minute');
  }
});

test('传入 noteId 也不再走智能纪要（产品明确不要这条路径）', () => {
  try {
    fetchTranscript({ noteId: 'note-123', topic: '只有智能纪要的会' });
    assert.fail('应该抛错，而不是去读智能纪要');
  } catch (e) {
    assert.equal(e.kind, 'no_minute', '有 noteId 但没有 minuteToken 时应直接判无妙记');
  }
});

test('妙记导出为空时明确报空，不静默往下走', () => {
  process.env.FAKE_LARK_MODE = 'minute-empty';
  try {
    fetchTranscript({ minuteToken: 'tok-empty', topic: '空会议' });
    assert.fail('应该抛错');
  } catch (e) {
    assert.match(e.message, /逐字稿为空|取不到/);
  } finally {
    process.env.FAKE_LARK_MODE = 'minute-ok';
  }
});

test('妙记无权限时，错误里保留原始原因，不退化成 AI 摘要', () => {
  process.env.FAKE_LARK_MODE = 'minute-denied';
  try {
    fetchTranscript({ minuteToken: 'tok-denied', topic: '受限会议' });
    assert.fail('应该抛错');
  } catch (e) {
    assert.match(e.message, /受限会议/);
    assert.match(e.message, /妙记转录稿取不到/, '要说清是取数失败');
    assert.match(e.message, /不会退化成 AI 摘要/);
    assert.equal(e.kind, 'minute_transcript_failed');
  } finally {
    process.env.FAKE_LARK_MODE = 'minute-ok';
  }
});
