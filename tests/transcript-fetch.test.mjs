/**
 * 逐字稿取数回归测试 —— 用假 lark-cli，不联网。
 *
 * 锁住三个真实踩过的坑：
 *   1. `--minute-token` 写成了单数（正确是 --minute-tokens）→ 妙记路径整个走不通
 *   2. 忘了传 `--transcript` → 只拿到基本信息，没有文字稿
 *   3. 导出目录用了 os.tmpdir()（macOS 是 /var/folders/...）→ 被 lark-cli 允许列表拒绝
 *
 * 第 3 点尤其阴：报错被 `allowFail` 吞掉时，用户看到的是"这场会没有逐字稿"，
 * 完全误导。所以这里既测成功路径，也测**失败时必须把原因说出来**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, 'helpers', 'fake-lark-cli.mjs');
chmodSync(FAKE, 0o755);

// lark.mjs 在模块加载时读取 LARK_CLI，所以必须先设环境变量再动态 import
process.env.LARK_CLI = FAKE;
process.env.FAKE_LARK_MODE = 'minute-ok';
const { fetchTranscript } = await import('../src/lark.mjs');

test('妙记路径：参数正确时能拿到逐字稿', () => {
  const t = fetchTranscript({ minuteToken: 'tok-abc', topic: '假会议' });
  assert.match(t, /甲 00:00:53\.530/);
  assert.match(t, /乙 00:00:55\.150/);
});

test('导出的逐字稿格式是引擎能直接解析的（无需转换）', () => {
  const t = fetchTranscript({ minuteToken: 'tok-abc', topic: '假会议' });
  const speakerLines = t.split('\n').filter((l) => /^.{1,48}?\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*/.test(l));
  assert.ok(speakerLines.length >= 2, `应识别出说话人行，实际 ${speakerLines.length}`);
});

test('妙记导出为空时，必须明确报空，而不是让下游静默失败', () => {
  process.env.FAKE_LARK_MODE = 'minute-empty';
  assert.throws(
    () => fetchTranscript({ minuteToken: 'tok-empty', topic: '空会议' }),
    /逐字稿为空|取不到逐字稿/,
  );
  process.env.FAKE_LARK_MODE = 'minute-ok';
});

test('妙记无权限且没有智能纪要时，错误信息要说清两条路径都不通', () => {
  process.env.FAKE_LARK_MODE = 'minute-denied';
  try {
    fetchTranscript({ minuteToken: 'tok-denied', topic: '受限会议' });
    assert.fail('应该抛错');
  } catch (e) {
    assert.match(e.message, /受限会议/);
    assert.match(e.message, /妙记路径失败/, '失败原因必须出现在错误里，不能被吞掉');
    assert.match(e.message, /无法替代/, '要说清为什么不能退化成 AI 摘要');
  } finally {
    process.env.FAKE_LARK_MODE = 'minute-ok';
  }
});

test('没有 minuteToken 也没有 noteId 时，直接说明没有妙记', () => {
  assert.throws(
    () => fetchTranscript({ topic: '没录制的会' }),
    /没有妙记 token/,
  );
});
