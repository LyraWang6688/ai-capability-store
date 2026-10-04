/**
 * 卡片与报告文档渲染自测 —— 纯函数，不联网。
 *
 * 卡片形态是产品明确指定的：**严格对齐 teaming-bot 线上的极简版**。
 * 这个测试的作用就是把它锁死，防止以后被"优化"成内容更丰富的版本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReportCard, renderReportDoc, renderReportMarkdown, reportDigest } from '../src/render.mjs';

const REPORT = {
  summary: '本次会议暂定位为可能是冷漠区或舒适区。',
  teamState: {
    zoneLabel: '可能是冷漠区或舒适区',
    analysis: '讨论从职业规划进入合作意向，成员表达了具体关切，但任务标准尚不明确。',
    psychologicalSafety: { summary: '证据不足以确认心理安全充足。', evidence: ['成员主动承认不确定'], limitation: '样本偏少' },
    accountability: { summary: '未形成团队共同承载的明确质量标准。', evidence: ['无验收节点'] },
    confidenceNote: '证据有限，结论偏保守。',
  },
  dialogueNetwork: {
    analysis: '互动集中在两人之间。',
    noteworthyPattern: '一方持续提出方向，另一方承接并补充。',
    nodes: [{ name: '方春剑', playerReason: '主要推动者', evidence: ['「我觉得真的可以考虑」'] }],
  },
  leaderAdvice: [{
    action: 'frame_for_learning',
    advice: '把当前合作从意向推进明确为需共同探索的学习任务',
    reasoning: '尚未明确质量标准与验证闭环',
    timing: '在梳理落地安排时',
    signalToWatch: '双方共同输出质量标准与验证节点',
    optionalScript: '我们先把验收标准说清楚',
  }],
  communication: [{ name: '方春剑' }, { name: 'Lyra Wang' }],
  unfinishedDialogues: [{ topic: '落地细节', conversationSoFar: '已达成合作意向', whatRemains: '质量标准与分工未定' }],
  unseenDisagreements: [],
};

// ─────────────────── 卡片：必须与线上一致 ───────────────────

test('卡片严格对齐线上：蓝色标题栏 + 固定大标题', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'ABC周二测试', reportUrl: 'https://x/docx/1' });
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.header.template, 'blue');
  assert.equal(card.header.title.tag, 'plain_text');
  assert.equal(card.header.title.content, '小组会议动力分析报告 已出炉');
});

test('卡片只有两个元素：一行会议名称 + 一个按钮（正文不进卡片）', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'ABC周二测试', reportUrl: 'https://x/docx/1' });
  assert.equal(card.elements.length, 2, `极简版应只有 2 个元素，实际 ${card.elements.length}`);
  assert.equal(card.elements[0].tag, 'markdown');
  assert.equal(card.elements[0].content, '**会议名称：**ABC周二测试');
  assert.equal(card.elements[1].tag, 'action');
});

test('卡片里绝对不能出现报告正文（区域、建议、成员等）', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'ABC周二测试', reportUrl: 'https://x/docx/1' });
  const text = JSON.stringify(card);
  for (const leak of ['可能'.concat('是冷漠区'), '最优先建议', '心理安全', '参与成员', '不评价个人']) {
    assert.ok(!text.includes(leak), `极简卡片不应包含「${leak}」`);
  }
});

test('按钮指向报告网页，文案固定为「点击查看报告」', () => {
  const card = renderReportCard(REPORT, { meetingTitle: 'X', reportUrl: 'https://my.feishu.cn/docx/abc' });
  const action = card.elements.find((e) => e.tag === 'action');
  assert.equal(action.actions[0].text.content, '点击查看报告');
  assert.equal(action.actions[0].url, 'https://my.feishu.cn/docx/abc');
  assert.equal(action.actions[0].type, 'primary');
});

test('没有会议名称时退回「会议报告已生成」（与线上一致）', () => {
  const card = renderReportCard(REPORT, { reportUrl: 'https://x' });
  assert.equal(card.elements[0].content, '会议报告已生成');
});

// ─────────────────── 报告文档：完整四部分，作为按钮落点 ───────────────────

test('报告文档包含四部分与小节标题', () => {
  const md = renderReportDoc(REPORT, { meetingTitle: 'ABC周二测试', startTime: '2026-09-22 11:36' });
  assert.match(md, /^# 小组会议动力分析报告/m);
  assert.match(md, /## 一、团队状态定位/);
  assert.match(md, /## 二、互动概览/);
  assert.match(md, /## 三、未完成的对话与值得被看见的非共识/);
  assert.match(md, /## 四、给领导者的建议/);
  assert.match(md, /ABC周二测试/);
  assert.match(md, /2026-09-22 11:36/);
});

test('报告文档把领导行为映射成中文小标题', () => {
  const md = renderReportDoc(REPORT, { meetingTitle: 'X' });
  assert.match(md, /### 为学习框定情境/);
  assert.ok(!md.includes('frame_for_learning'), '不应把后台枚举值暴露给读者');
});

test('报告文档带「不评价个人」的收尾', () => {
  const md = renderReportDoc(REPORT, { meetingTitle: 'X' });
  assert.match(md, /不评价个人/);
});

test('报告文档能容忍缺字段的旧报告，不抛错', () => {
  const md = renderReportDoc({ teamState: { zone: 'Learning' } }, { meetingTitle: 'X' });
  assert.match(md, /学习区|Learning/);
  assert.match(md, /不评价个人/);
});

// ─────────────────── 摘要与纯文本（辅助用途） ───────────────────

test('reportDigest 给出紧凑摘要，不含大字段', () => {
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
