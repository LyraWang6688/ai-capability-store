/**
 * 报告渲染：JSON 报告 → 飞书消息 markdown
 *
 * 原则：消息里只放"结论 + 最优先建议"，完整报告留在本地文件/网页。
 * 不要把整份报告塞进消息——飞书消息有体积上限，用户也读不完。
 */

const oneLine = (s, max = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * 报告 → 飞书**交互卡片**。
 *
 * **严格对齐 teaming-bot 线上的极简版**：蓝色标题栏 + 一行会议名称 + 一个按钮。
 * 报告正文不放卡片里，走「点击查看报告」跳转（本地链路里落点是飞书云文档）。
 *
 * 这是产品明确要求的形态，不要"优化"成内容更丰富的版本。
 */
export function renderReportCard(report, { meetingTitle, reportUrl } = {}) {
  const detailLines = meetingTitle ? [`**会议名称：**${meetingTitle}`] : ['会议报告已生成'];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '小组会议动力分析报告 已出炉' },
    },
    elements: [
      { tag: 'markdown', content: detailLines.join('\n') },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: '点击查看报告' },
          url: reportUrl,
        }],
      },
    ],
  };
}

/**
 * 报告 → 飞书云文档的 markdown 正文。
 * 这是「点击查看报告」的落地页内容：完整四部分。
 */
export function renderReportDoc(report, { meetingTitle, startTime } = {}) {
  const ts = report.teamState || {};
  const zone = ts.zoneLabel || ts.zone || '未定位';
  const L = [];

  L.push('# 小组会议动力分析报告');
  L.push('');
  if (meetingTitle) L.push(`**会议：**${meetingTitle}`);
  if (startTime) L.push(`**时间：**${startTime}`);
  L.push(`**区域定位：**${zone}`);
  L.push('');

  L.push('## 一、团队状态定位');
  L.push('');
  if (ts.analysis) { L.push(ts.analysis); L.push(''); }
  if (ts.psychologicalSafety?.summary) {
    L.push(`**心理安全**：${ts.psychologicalSafety.summary}`);
    (ts.psychologicalSafety.evidence || []).forEach((e) => L.push(`- ${e}`));
    if (ts.psychologicalSafety.limitation) L.push(`_限制：${ts.psychologicalSafety.limitation}_`);
    L.push('');
  }
  if (ts.accountability?.summary) {
    L.push(`**高要求与问责**：${ts.accountability.summary}`);
    (ts.accountability.evidence || []).forEach((e) => L.push(`- ${e}`));
    if (ts.accountability.limitation) L.push(`_限制：${ts.accountability.limitation}_`);
    L.push('');
  }
  if (ts.confidenceNote) { L.push(`_${ts.confidenceNote}_`); L.push(''); }

  const net = report.dialogueNetwork || {};
  if ((net.nodes || []).length || net.analysis) {
    L.push('## 二、互动概览');
    L.push('');
    if (net.analysis) { L.push(net.analysis); L.push(''); }
    for (const n of net.nodes || []) {
      L.push(`**${n.name || ''}**：${n.playerReason || ''}`);
      if ((n.evidence || []).length) L.push(`> ${n.evidence[0]}`);
      L.push('');
    }
    if (net.noteworthyPattern) { L.push(`**值得注意的互动模式**：${net.noteworthyPattern}`); L.push(''); }
  }

  const unfinished = report.unfinishedDialogues || [];
  const disagreement = report.unseenDisagreements || [];
  if (unfinished.length || disagreement.length) {
    L.push('## 三、未完成的对话与值得被看见的非共识');
    L.push('');
    if (unfinished.length) {
      L.push('### 未完成的对话');
      for (const u of unfinished) {
        L.push(`**${u.topic || ''}**`);
        L.push(`- 已讨论到：${u.conversationSoFar || ''}`);
        L.push(`- 尚缺少：${u.whatRemains || ''}`);
        L.push('');
      }
    }
    if (disagreement.length) {
      L.push('### 值得被看见的非共识');
      for (const d of disagreement) {
        L.push(`**${d.topic || ''}**`);
        L.push(`- 不同关注：${d.differentConcerns || ''}`);
        L.push(`- 共同目标：${d.sharedGoal || ''}`);
        if (d.whyItMatters) L.push(`- 影响：${d.whyItMatters}`);
        L.push('');
      }
    }
  }

  const advice = report.leaderAdvice || [];
  if (advice.length) {
    L.push('## 四、给领导者的建议');
    L.push('');
    const ACTION_CN = {
      frame_for_learning: '为学习框定情境',
      create_psychological_safety: '营造心理安全',
      learn_from_failure: '从失败中学习',
      cross_boundaries: '跨越边界',
    };
    for (const a of advice) {
      L.push(`### ${ACTION_CN[a.action] || a.action || '建议'}`);
      L.push(a.advice || '');
      if (a.reasoning) { L.push(''); L.push(`**为什么**：${a.reasoning}`); }
      if (a.timing) { L.push(''); L.push(`**什么时候做**：${a.timing}`); }
      if (a.signalToWatch) { L.push(''); L.push(`**怎么验收**：${a.signalToWatch}`); }
      if (a.optionalScript) { L.push(''); L.push(`**可以参考的话术**：${a.optionalScript}`); }
      L.push('');
    }
  }

  if (report.crossBoundaryLearning?.summary) {
    L.push('## 附：跨边界学习');
    L.push('');
    L.push(report.crossBoundaryLearning.summary);
    L.push('');
  }

  L.push('---');
  L.push('_本报告只观察会议过程，不评价个人。_');
  return L.join('\n');
}

export function renderReportMarkdown(report, { meetingTitle, reportUrl } = {}) {
  const ts = report.teamState || {};
  const zone = ts.zoneLabel || ts.zone || '未定位';
  const advice = (report.leaderAdvice || [])[0];
  const unfinished = report.unfinishedDialogues || [];
  const disagreement = report.unseenDisagreements || [];
  const members = (report.communication || []).map((c) => c.name).filter(Boolean);

  const L = [];
  L.push('**小组会议动力分析报告 已出炉**');
  if (meetingTitle) L.push(`会议：${meetingTitle}`);
  L.push('');
  L.push(`**区域定位**：${zone}`);
  if (ts.psychologicalSafety?.summary) L.push(`**心理安全**：${oneLine(ts.psychologicalSafety.summary)}`);
  if (ts.accountability?.summary) L.push(`**高要求与问责**：${oneLine(ts.accountability.summary)}`);
  if (advice) {
    L.push('');
    L.push(`**最优先建议**：${advice.advice || ''}`);
    if (advice.reasoning) L.push(oneLine(advice.reasoning));
    if (advice.signalToWatch) L.push(`_验收信号_：${oneLine(advice.signalToWatch)}`);
  }
  if (unfinished.length) {
    L.push('');
    L.push('**未完成的对话**');
    unfinished.slice(0, 3).forEach((u) => L.push(`- ${u.topic || ''}：${oneLine(u.whatRemains, 80)}`));
  }
  if (disagreement.length) {
    L.push('');
    L.push('**值得被看见的非共识**');
    disagreement.slice(0, 3).forEach((d) => L.push(`- ${d.topic || ''}：${oneLine(d.differentConcerns, 80)}`));
  }
  if (members.length) { L.push(''); L.push(`参与成员：${members.join('、')}`); }
  if (reportUrl) { L.push(''); L.push(`[查看完整报告](${reportUrl})`); }
  L.push('');
  L.push('_本报告只观察会议过程，不评价个人。_');
  return L.join('\n');
}

/** 给 MCP/CLI 用的紧凑摘要——不回灌正文 */
export function reportDigest(report) {
  const ts = report.teamState || {};
  return {
    zone: ts.zoneLabel || ts.zone || '未定位',
    summary: oneLine(report.summary, 200),
    psychological_safety: oneLine(ts.psychologicalSafety?.summary, 200),
    accountability: oneLine(ts.accountability?.summary, 200),
    top_advice: (report.leaderAdvice || [])[0]?.advice || '',
    signal_to_watch: (report.leaderAdvice || [])[0]?.signalToWatch || '',
    unfinished_count: (report.unfinishedDialogues || []).length,
    disagreement_count: (report.unseenDisagreements || []).length,
    members: (report.communication || []).map((c) => c.name).filter(Boolean),
  };
}
