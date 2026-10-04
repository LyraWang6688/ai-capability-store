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
