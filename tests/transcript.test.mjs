/**
 * 逐字稿转换自测 —— 纯函数，不联网。
 * 夹具取自真实的飞书智能纪要逐字稿文档结构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToTranscript } from '../src/lark.mjs';

test('飞书逐字稿 HTML → 引擎可解析格式', () => {
  const html = '<title>文字记录：ABC周二测试</title>'
    + '<blockquote><p>会议主题：ABC周二测试<br/>会议时间：2026年9月22日</p></blockquote>'
    + '<p><cite type="user" uid-ref="u1" user-name="方春剑"></cite> 00:00:09<br/>我还投屏了。</p>'
    + '<p></p>'
    + '<p>@Lyra Wang 00:00:12<br/>好的，你来投屏吧。</p>'
    + '<p>说话人 1 用 @Lyra Wang 的设备 00:01:24<br/>嗯。</p>';

  const out = htmlToTranscript(html);
  const lines = out.split('\n');

  assert.equal(lines.length, 3, `应产出 3 条发言，实际 ${lines.length}`);
  assert.match(lines[0], /^方春剑 00:00:09 我还投屏了。$/);
  assert.match(lines[1], /^Lyra Wang 00:00:12 好的，你来投屏吧。$/);
  assert.match(lines[2], /^说话人 1（设备） 00:01:24 嗯。$/);

  // 引擎的 matchSpeakerLine 认这个形状：`姓名 MM:SS 内容`
  for (const line of lines) {
    assert.match(line, /^.{1,48}?\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s+\S/, `形状不对：${line}`);
  }
});

test('头部 blockquote 不会被当成发言', () => {
  const html = '<blockquote><p>会议主题：X<br/>会议时间：2026年9月22日</p></blockquote>'
    + '<p>甲 00:00:01<br/>开始吧。</p>';
  const out = htmlToTranscript(html);
  assert.equal(out.split('\n').length, 1);
  assert.ok(!out.includes('会议主题'));
});

test('实体字符还原', () => {
  const html = '<p>甲 00:00:01<br/>A &amp; B &lt;tag&gt;</p>';
  const out = htmlToTranscript(html);
  assert.ok(out.includes('A & B <tag>'), out);
});

test('没有可解析发言时报错，而不是静默返回空', () => {
  assert.throws(() => htmlToTranscript('<p>这里没有任何说话人时间戳</p>'), /没有任何发言/);
});
