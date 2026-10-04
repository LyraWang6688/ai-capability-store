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
 * 结构与 teaming-bot 线上卡片对齐：蓝色标题栏 + 同样的大标题 + 动作按钮。
 * 本机场景没有报告网页可跳，因此把报告摘要放进卡片正文，
 * 有 reportUrl 时仍然给出「点击查看报告」按钮。
 */
export function renderReportCard(report, { meetingTitle, reportUrl } = {}) {
  const ts = report.teamState || {};
  const zone = ts.zoneLabel || ts.zone || '未定位';
  const advice = (report.leaderAdvice || [])[0];
  const elements = [];

  if (meetingTitle) elements.push({ tag: 'markdown', content: `**会议名称：**${meetingTitle}` });
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: `**区域定位**：${zone}` });
  if (ts.psychologicalSafety?.summary) {
    elements.push({ tag: 'markdown', content: `**心理安全**：${oneLine(ts.psychologicalSafety.summary, 180)}` });
  }
  if (ts.accountability?.summary) {
    elements.push({ tag: 'markdown', content: `**高要求与问责**：${oneLine(ts.accountability.summary, 180)}` });
  }

  if (advice) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `**最优先建议**：${advice.advice || ''}` });
    if (advice.reasoning) elements.push({ tag: 'markdown', content: oneLine(advice.reasoning, 180) });
    if (advice.signalToWatch) elements.push({ tag: 'markdown', content: `_验收信号_：${oneLine(advice.signalToWatch, 140)}` });
  }

  const members = (report.communication || []).map((c) => c.name).filter(Boolean);
  if (members.length) {
    elements.push({ tag: 'markdown', content: `**参与成员**：${members.join('、')}` });
  }

  if (reportUrl) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        type: 'primary',
        text: { tag: 'plain_text', content: '点击查看报告' },
        url: reportUrl,
      }],
    });
  }

  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '本报告只观察会议过程，不评价个人。' }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '小组会议动力分析报告 已出炉' },
    },
    elements,
  };
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
