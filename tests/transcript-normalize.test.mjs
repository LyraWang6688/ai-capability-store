/**
 * 逐字稿归一化测试。
 *
 * 背景：新架构下逐字稿由**宿主**提供，形态不受我们控制——
 * 可能是妙记导出的纯文本，也可能是从飞书文档抓来的 HTML。
 * 而引擎只认 `姓名 MM:SS 内容` 这个形状。
 *
 * 另外一条硬规则：**不给不出结论**。逐字稿不合格时必须明确拒绝，
 * 而不是硬跑出一份看起来像报告的东西。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeHtml,
  htmlToTranscript,
  countSpeakerLines,
  normalizeTranscript,
  TranscriptError,
} from '../src/transcript.mjs';

const PLAIN = [
  'Lyra Wang 00:05 我们先过一下今天的议程。',
  '方春剑 00:22 我负责开场，但不确定讲多久。',
  '周敏萱 00:52 我担心案例太少，要不要加一个。',
  'Lyra Wang 01:10 可以加，周四之前给我看看。',
  '方春剑 01:40 好的，那我周三把稿子发群里。',
  '周敏萱 02:05 如果案例来不及，备选方案是什么？',
].join('\n');

// ─────────── HTML 识别与转换 ───────────

test('纯文本不会被当成 HTML', () => {
  assert.equal(looksLikeHtml(PLAIN), false);
});

test('含标签的文本会被识别为 HTML', () => {
  assert.equal(looksLikeHtml('<p>你好</p>'), true);
  assert.equal(looksLikeHtml('a&nbsp;b'), true);
});

test('★ HTML 里的 <title> 必须剥掉（否则会污染第一条发言的发言人）', () => {
  const html = '<html><head><title>ABC测试会议</title></head>'
    + '<body><p>Lyra Wang 00:05 开始</p><p>方春剑 00:22 好的</p></body></html>';
  const text = htmlToTranscript(html);
  assert.ok(!text.includes('ABC测试会议'), '标题不该出现在逐字稿里');
  assert.ok(text.startsWith('Lyra Wang 00:05 开始'), '第一条发言必须干净');
});

test('块级元素转成换行，标签全部去掉', () => {
  const text = htmlToTranscript('<div>甲 00:01 一</div><div>乙 00:02 二</div>');
  assert.deepEqual(text.split('\n'), ['甲 00:01 一', '乙 00:02 二']);
});

test('HTML 实体被解码', () => {
  assert.equal(htmlToTranscript('<p>a&amp;b&nbsp;c</p>'), 'a&b c');
});

test('script/style/head 整段去掉', () => {
  const text = htmlToTranscript('<head><meta charset="utf-8"></head><style>p{}</style>'
    + '<script>var x=1</script><p>甲 00:01 一</p>');
  assert.equal(text, '甲 00:01 一');
});

// ─────────── 发言行识别 ───────────

test('认出「姓名 MM:SS 内容」形式的发言行', () => {
  assert.equal(countSpeakerLines(PLAIN), 6);
});

test('兼容 MM:SS.mmm 与 HH:MM:SS', () => {
  const t = '甲 00:01.500 一\n乙 01:02:03 二\n丙 00:03 三\n丁 00:04 四\n戊 00:05 五';
  assert.equal(countSpeakerLines(t), 5);
});

test('不含时间戳的行不算发言', () => {
  assert.equal(countSpeakerLines('这是一段普通文字\n没有时间戳'), 0);
});

// ─────────── normalizeTranscript：合格与拒绝 ───────────

test('合格纯文本直接通过', () => {
  const r = normalizeTranscript(PLAIN);
  assert.equal(r.speakerLines, 6);
  assert.ok(r.text.includes('周敏萱 02:05'));
});

test('合格 HTML 被转换后通过', () => {
  const html = '<title>无关标题</title>' + PLAIN.split('\n').map((l) => `<p>${l}</p>`).join('');
  const r = normalizeTranscript(html);
  assert.equal(r.speakerLines, 6);
  assert.ok(!r.text.includes('无关标题'));
});

test('★ 空逐字稿被明确拒绝', () => {
  assert.throws(() => normalizeTranscript(''), (e) => e instanceof TranscriptError && e.kind === 'transcript_empty');
  assert.throws(() => normalizeTranscript('   '), TranscriptError);
});

test('★ AI 摘要/普通文字被拒绝，而不是硬跑一次模型', () => {
  const summary = '本次会议讨论了权限配置问题，团队处于冷漠区，建议建立验证机制。';
  assert.throws(
    () => normalizeTranscript(summary),
    (e) => e instanceof TranscriptError && e.kind === 'transcript_not_speaker_lines'
  );
});

test('发言行太少也被拒绝（避免对三两句话下判断）', () => {
  assert.throws(
    () => normalizeTranscript('甲 00:01 一\n乙 00:02 二'),
    (e) => e instanceof TranscriptError && e.kind === 'transcript_not_speaker_lines'
  );
});

test('拒绝时的报错要说人话、给下一步', () => {
  try {
    normalizeTranscript('随便一段话');
    assert.fail('应当抛错');
  } catch (e) {
    assert.match(e.message, /不是可用的逐字稿/);
    assert.match(e.message, /妙记导出的文字转录稿/);
    assert.match(e.message, /不接受 AI 摘要/);
  }
});

test('CRLF 换行也能处理', () => {
  const r = normalizeTranscript(PLAIN.replace(/\n/g, '\r\n'));
  assert.equal(r.speakerLines, 6);
});
