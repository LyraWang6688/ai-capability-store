/**
 * 编排层：把「取数 → 分析 → 落盘 → 推送」串起来
 *
 * CLI 和 MCP 都调用这一层，业务逻辑只写一遍。
 * 落盘位置、幂等账本都归这里管。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  searchMeetings, meetingDetail, fetchTranscript, sendMessage, LarkError,
} from './lark.mjs';
import { analyze } from './analysis.mjs';
import { renderReportMarkdown } from './render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const OUT_DIR = process.env.TEAMING_OUT || join(ROOT, '.out');
const STATE_DIR = join(ROOT, '.state');
const LEDGER = join(STATE_DIR, 'processed.json');

const safeName = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 60);

/** 报告落盘路径（约定：<标题>-<meetingId>.report.json），MCP 靠它反查 */
export function reportPathFor(meetingId) {
  if (!existsSync(OUT_DIR)) return null;
  const hit = readdirSync(OUT_DIR).find((f) => f.endsWith(`${meetingId}.report.json`));
  return hit ? join(OUT_DIR, hit) : null;
}

export function readReport(meetingId) {
  const p = reportPathFor(meetingId);
  if (!p) return null;
  try { return { path: p, report: JSON.parse(readFileSync(p, 'utf8')) }; } catch { return null; }
}

/** 完整分析一场会议；返回落盘路径与报告对象 */
export async function analyzeMeeting(meetingId, { onProgress = () => {} } = {}) {
  const detail = meetingDetail(meetingId);
  if (!detail) throw new LarkError(`找不到会议 ${meetingId}。`, { kind: 'meeting_not_found' });
  onProgress({ step: 'detail', detail });
  if (detail.minuteDenied) onProgress({ step: 'note', message: '妙记无权限，改用智能纪要逐字稿' });

  const transcript = fetchTranscript(detail);
  onProgress({ step: 'transcript', turns: transcript.split('\n').length, chars: transcript.length });

  const t0 = Date.now();
  const report = await analyze(transcript);
  onProgress({ step: 'analyzed', seconds: Math.round((Date.now() - t0) / 1000) });

  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${safeName(detail.topic)}-${meetingId}`;
  const reportPath = join(OUT_DIR, `${base}.report.json`);
  const transcriptPath = join(OUT_DIR, `${base}.transcript.txt`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(transcriptPath, transcript);

  return { meetingId, topic: detail.topic, startTime: detail.startTime, report, reportPath, transcriptPath };
}

/** 推送报告到飞书（幂等） */
export function pushReport(report, { chatId, userId, meetingTitle, reportUrl }) {
  const markdown = renderReportMarkdown(report, { meetingTitle, reportUrl });
  const zone = report.teamState?.zoneLabel || report.teamState?.zone || '未定位';
  const idem = `teaming-${safeName(meetingTitle || 'meeting')}-${safeName(zone)}`;
  return sendMessage({ chatId, userId, markdown, idempotencyKey: idem });
}

// ───────────────────── 事件驱动（妙记生成 → 分析 → 推送） ─────────────────────

function readLedger() {
  try { return JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { return { events: {}, minutes: {} }; }
}
function writeLedger(l) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

/** 事件的标题可能带「录制：」等前缀，做一次宽松匹配 */
export function resolveMeetingByTitle(title) {
  if (!title) return null;
  const clean = String(title).replace(/^(录制|云文档)[:：]/, '').trim();
  const list = searchMeetings({ days: 90 });
  return list.find((m) => m.title === clean)
    || list.find((m) => m.title && (clean.includes(m.title) || m.title.includes(clean)))
    || null;
}

/**
 * 处理一条 minutes.minute.generated_v1 事件。
 *
 * 幂等：event_id 与 minute_token 双键去重；账本在"推送之前"落盘，
 * 保证崩溃重放时不会重复分析、也不会重复推送。
 * 顺序：去重 → 定位会议 → 取逐字稿 → 分析 → 落账本 → 推送。
 */
export async function handleMinuteEvent(ev, { chatId, userId, onProgress = () => {} } = {}) {
  const eventId = ev.event_id || null;
  const minuteToken = ev.minute_token || null;
  const title = ev.title || null;
  const ledger = readLedger();

  if (eventId && ledger.events[eventId]) return { skipped: true, reason: 'duplicate_event' };
  if (minuteToken && ledger.minutes[minuteToken]) return { skipped: true, reason: 'duplicate_minute' };

  const meeting = resolveMeetingByTitle(title);
  if (!meeting) {
    return {
      skipped: true,
      reason: 'meeting_not_found',
      message: `按标题「${title}」找不到会议，无法取逐字稿。`
        + '（妙记也可能来自本地音视频上传，不属于任何会议）',
    };
  }

  const result = await analyzeMeeting(meeting.meetingId, { onProgress });

  // 账本先落：即使随后的推送失败，也不会重复分析
  if (eventId) ledger.events[eventId] = { at: new Date().toISOString(), minuteToken, meetingId: meeting.meetingId };
  if (minuteToken) ledger.minutes[minuteToken] = { at: new Date().toISOString(), meetingId: meeting.meetingId };
  writeLedger(ledger);

  let pushed = null;
  if (chatId || userId) {
    pushed = pushReport(result.report, { chatId, userId, meetingTitle: result.topic });
  }
  return { skipped: false, ...result, pushed };
}

/** 本地已处理的会议台账（给 MCP 的 list 用，避免重复推荐） */
export function analyzedMeetings() {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.report.json'))
    .map((f) => {
      const m = /-(\d+)\.report\.json$/.exec(f);
      return { meetingId: m ? m[1] : null, file: f, title: f.replace(/-\d+\.report\.json$/, '') };
    })
    .filter((x) => x.meetingId);
}
