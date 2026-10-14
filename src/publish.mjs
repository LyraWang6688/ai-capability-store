/**
 * 把本地生成的报告发布到 teaming-bot 服务器，换取报告页 URL。
 *
 * 为什么要这一步：报告页（四象限图 + 语义互动网络图 + PDF 导出）在服务器上，
 * 飞书云文档是纯文本，**无法复现那两张图和导出能力**。
 * 所以卡片按钮的正解是服务器报告页，飞书文档只当兜底。
 *
 * 服务端契约（已于 2026-10-14 实现，见 teaming-bot 的 src/app/api/host/v1/reports/route.ts）：
 *   POST {TEAMING_SERVER_URL}/api/host/v1/reports
 *   Authorization: Bearer {TEAMING_HOST_TOKEN}
 *   Content-Type: application/json
 *   {
 *     "meetingTitle": "...",
 *     "meetingStartedAt": "2026-09-22 11:36",     // 可空
 *     "feishuMeetingId": "7688...",                // 可空
 *     "analysisResult": { ...完整 AnalysisResultV2... },
 *     "transcript": "...",                         // 可空；传了才落库
 *     "clientRequestId": "..."                     // 幂等键
 *   }
 *   → 200 { "reportPublicId": "uuid", "reportUrl": "https://.../report/uuid" }
 *
 * 设计取舍：发布失败**不阻断推送**——退回飞书文档兜底，并在返回里标注用了哪条路径，
 * 避免"报告页挂了就什么都看不到"。
 */
import { createHash } from 'node:crypto';

const SERVER_URL = () => (process.env.TEAMING_SERVER_URL || '').replace(/\/+$/, '');
const HOST_TOKEN = () => process.env.TEAMING_HOST_TOKEN || '';

export function serverPublishConfigured() {
  return Boolean(SERVER_URL() && HOST_TOKEN());
}

/** 幂等键：同一会议 + 同一份报告内容只发布一次 */
function requestIdFor(report, meetingTitle) {
  return createHash('sha256')
    .update(String(meetingTitle || ''))
    .update(JSON.stringify(report.teamState || {}))
    .update(String(report.reportTimestamp || ''))
    .digest('hex')
    .slice(0, 32);
}

/**
 * 发布报告到服务器。
 * @returns {Promise<{url: string, reportPublicId: string}|null>} 失败返回 null（由调用方兜底）
 */
export async function publishReportToServer(report, { meetingTitle, startTime, feishuMeetingId, transcript } = {}) {
  if (!serverPublishConfigured()) return null;
  // 路径带 /v1/：对齐 teaming-bot 的 ADR（docs/AI宿主接入设计.md 第九章）。
  // 曾经这里写的是 /api/host/reports，服务端按 ADR 实现的是 /api/host/v1/*，两边对不上。
  const url = `${SERVER_URL()}/api/host/v1/reports`;
  const body = {
    meetingTitle: meetingTitle || null,
    meetingStartedAt: startTime || null,
    feishuMeetingId: feishuMeetingId || null,
    analysisResult: report,
    transcript: transcript || null,
    clientRequestId: requestIdFor(report, meetingTitle),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${HOST_TOKEN()}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const reportUrl = data?.reportUrl || (data?.reportPublicId ? `${SERVER_URL()}/report/v2/${data.reportPublicId}` : null);
    if (!reportUrl) return null;
    return { url: reportUrl, reportPublicId: data?.reportPublicId || null };
  } catch {
    return null;   // 网络/超时/证书问题都走兜底，不让推送整体失败
  } finally {
    clearTimeout(timer);
  }
}
