/**
 * 卡片渲染自测 —— 纯函数，不联网。
 *
 * 重点：卡片必须与 teaming-bot 线上的形态一致（蓝色标题栏 + 同样的大标题），
 * 这是产品上明确要求过的，不能被"优化"成纯文本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReportCard, renderReportMarkdown, reportDigest } from '../src/render.mjs';

const REPORT = {
  summary: '本次会议暂定位为可能是冷漠区或舒适区。',
  teamState: {
    zoneLabel: '可能是冷漠区或舒适区',
    psychologicalSafety: { summary: '证据不足以确认心理安全充足。' },
    accountability: { summary: '未形成团队共同承载的明确质量标准。' },
  },
  leaderAdvice: [{
    action: 'frame_for_learning',
    advice: '把当前合作从意向推进明确为需共同探索的学习任务',
    reasoning: '尚未明确质量标准与验证闭环',
    signalToWatch: '双方共同输出质量标准与验证节点',
  }],
  communication: [{ name: '方春剑' }, { name: 'Lyra Wang' }],
  unfinishedDialogues: [],
  unseenDisagreements: [],
};

test('卡片形态与线上一致：蓝色标题栏 + 固定大标题', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'ABC周二测试' });
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.header.template, 'blue');
  assert.equal(card.header.title.tag, 'plain_text');
  assert.equal(card.header.title.content, '小组会议动力分析报告 已出炉');
});

test('卡片必须包含会议名称与区域定位', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'ABC周二测试' });
  const text = JSON.stringify(card.elements);
  assert.match(text, /会议名称/);
  assert.match(text, /ABC周二测试/);
  assert.match(text, /可能是冷漠区或舒适区/);
  assert.match(text, /最优先建议/);
  assert.match(text, /参与成员/);
});

test('有报告链接时给出「点击查看报告」按钮', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'X', reportUrl: 'https://example.com/r/1' });
  const action = card.elements.find((e) => e.tag === 'action');
  assert.ok(action, '应包含动作区');
  assert.equal(action.actions[0].text.content, '点击查看报告');
  assert.equal(action.actions[0].url, 'https://example.com/r/1');
});

test('没有报告链接时不出现空按钮', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'X' });
  assert.equal(card.elements.find((e) => e.tag === 'action'), undefined);
});

test('卡片以「不评价个人」的脚注收尾', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'X' });
  const last = card.elements[card.elements.length - 1];
  assert.equal(last.tag, 'note');
  assert.match(last.elements[0].content, /不评价个人/);
});

test('卡片正文受长度约束，不会把整份报告塞进去', () => {
  const long = JSON.parse(JSON.stringify(REPORT));
  long.teamState.psychologicalSafety.summary = '很长的内容'.repeat(200);
  const card = renderReportCard(long, { meetingTitle: 'X' });
  const bytes = JSON.stringify(card).length;
  assert.ok(bytes < 8000, `卡片体积应受控，实际 ${bytes} 字节`);
});

test('reportDigest 给出紧凑摘要，不包含逐字稿类大字段', () => {
  const d = reportDigest(REPORT);
  assert.equal(d.zone, '可能是冷漠区或舒适区');
  assert.deepEqual(d.members, ['方春剑', 'Lyra Wang']);
  assert.ok(!('transcript' in d));
  assert.ok(JSON.stringify(d).length < 2000);
});

test('markdown 渲染仍可用（供纯文本场景）', () => {
  const md = renderReportMarkdown(REPORT, { meetingTitle: 'X' });
  assert.match(md, /小组会议动力分析报告 已出炉/);
  assert.match(md, /不评价个人/);
});
