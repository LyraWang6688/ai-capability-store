/**
 * 编排层：把「取数 → 分析 → 落盘 → 推送」串起来
 *
 * CLI 和 MCP 都调用这一层，业务逻辑只写一遍。
 * 落盘位置、幂等账本都归这里管。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  searchMeetings, meetingDetail, meetingDetailsBatch, fetchTranscript, sendMessage, createDoc, LarkError,
} from './lark.mjs';
import { analyze } from './analysis.mjs';
import { normalizeTranscript } from './transcript.mjs';
import { renderReportCard, renderReportDoc } from './render.mjs';
import { publishReportToServer } from './publish.mjs';

import { resolveOutDir, resolveStateDir } from './paths.mjs';

// 数据目录按「git 检出 vs npm 安装」分流，见 paths.mjs：
// 全局安装时包目录在 node_modules 里，既可能不可写、升级也会被清掉。
export const OUT_DIR = resolveOutDir();
const STATE_DIR = resolveStateDir();
const LEDGER = join(STATE_DIR, 'processed.json');

const safeName = (s) => String(s).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 60);

/** 报告落盘路径（约定：<标题>-<meetingId>.report.json），MCP 靠它反查 */
export function reportPathFor(meetingId) {
  // 没有合法 id 就不要猜——猜错会把【别人的报告】发出去。
  //
  // 曾经的写法少了这一道：meetingId 为 undefined 时，
  //   ① 文件名比对退化成 "undefined.report.json"，匹配不到（无害）；
  //   ② 但接着遍历报告读 meetingRef，`ref.id === meetingId` 就变成
  //      `ref.id === undefined`——只要某份报告缺 meetingRef（ref = {}），
  //      它就成立了，于是静默返回那份报告。
  // 后果：宿主漏传 meeting_id 时不会报错，而是拿到另一场会的报告并据此发卡片。
  // 2026-10-15 实测复现：调 teaming_report_card 不传 meeting_id，
  // 它返回了目录里另一份报告的链接。
  if (typeof meetingId !== 'string' || meetingId.trim() === '') return null;

  if (!existsSync(OUT_DIR)) return null;

  // ① 文件名约定：<标题>-<id>.report.json
  const hit = readdirSync(OUT_DIR).find((f) => f.endsWith(`${meetingId}.report.json`));
  if (hit) return join(OUT_DIR, hit);

  // ② 退一步读报告里的 meetingRef。
  //    供稿模式下文件名里的 id 可能是【内容哈希】，而宿主持有的是【飞书
  //    meeting_id】——只按文件名匹配会找不到报告（2026-10-15 实测踩到）。
  const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.report.json'));
  for (const f of files) {
    try {
      const ref = JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8'))?.meetingRef || {};
      if (ref.id === meetingId || ref.feishuMeetingId === meetingId) return join(OUT_DIR, f);
    } catch { /* 坏文件跳过，不影响其它候选 */ }
  }
  return null;
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

  const transcript = fetchTranscript({ minuteToken: detail.minuteToken, topic: detail.topic });
  onProgress({ step: 'transcript', turns: transcript.split('\n').length, chars: transcript.length });

  const t0 = Date.now();
  // 带上飞书 meeting_id：服务器用它做幂等键，同一场会重复分析不会重复出报告。
  // 标题也一并传，报告页用它命名。
  const report = await analyze(transcript, {
    feishuMeetingId: meetingId,
    title: detail.topic || null,
  });
  onProgress({ step: 'analyzed', seconds: Math.round((Date.now() - t0) / 1000) });

  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${safeName(detail.topic)}-${meetingId}`;
  const reportPath = join(OUT_DIR, `${base}.report.json`);
  const transcriptPath = join(OUT_DIR, `${base}.transcript.txt`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(transcriptPath, transcript);

  return { meetingId, topic: detail.topic, startTime: detail.startTime, report, reportPath, transcriptPath };
}

/**
 * 分析**由宿主提供的**逐字稿——不碰飞书、不调 lark-cli。
 *
 * ## 为什么需要它
 *
 * 2026-10-14 确定了新架构：**宿主（豆包工作/WorkBuddy）自己取数，MCP 只做分析。**
 *
 * 起因是豆包账号在飞书侧被彻底限制：既不能创建应用，也不能授权已有应用。
 * 而宿主自带飞书能力（豆包工作用的是它自己的内部应用），所以取数交给宿主，
 * MCP 就完全不需要飞书授权了。
 *
 * ## 与 analyzeMeeting 的区别
 *
 * | | analyzeMeeting | analyzeProvidedTranscript |
 * |---|---|---|
 * | 逐字稿来源 | 本 MCP 经 lark-cli 取 | **调用方传入** |
 * | 需要飞书授权 | 需要 | **不需要** |
 * | 幂等键 | meetingId | meetingId，或逐字稿内容哈希 |
 */
export async function analyzeProvidedTranscript({
  transcript,
  title = '会议',
  meetingId = null,
  onProgress = () => {},
} = {}) {
  const { text, speakerLines } = normalizeTranscript(transcript);
  onProgress({ step: 'transcript', turns: speakerLines, chars: text.length });

  const t0 = Date.now();
  // 这里只传调用方明确给的 meetingId 与标题。
  // 没有 meetingId 时**不传**——让服务器用逐字稿内容哈希做幂等键，
  // 与本函数下面的本地 id 规则一致（同一份稿重复调不会重复出报告）。
  const report = await analyze(text, {
    feishuMeetingId: meetingId || null,
    title: String(title || '').trim() || null,
  });
  onProgress({ step: 'analyzed', seconds: Math.round((Date.now() - t0) / 1000) });

  // 没有 meetingId 时用内容哈希当标识：同一份逐字稿重复调用会复用同一份报告，
  // 不会重复烧模型（幂等键来自内容，而不是调用次数）。
  const id = meetingId || `h${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
  const topic = String(title || '会议').trim() || '会议';

  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${safeName(topic)}-${id}`;
  const reportPath = join(OUT_DIR, `${base}.report.json`);
  const transcriptPath = join(OUT_DIR, `${base}.transcript.txt`);

  // 把身份信息一起落盘，供两件事：
  //   ① reportPathFor 能按【飞书 meeting_id】反查到报告——
  //      供稿模式下文件名里的 id 可能是内容哈希，宿主持有的是飞书 ID，
  //      只靠文件名匹配会找不到（2026-10-15 实测踩到）；
  //   ② 之后渲染卡片时能拿到会议标题。
  const stored = {
    ...report,
    meetingRef: {
      id,
      feishuMeetingId: meetingId || null,
      title: topic,
      savedAt: new Date().toISOString(),
    },
  };
  writeFileSync(reportPath, JSON.stringify(stored, null, 2));
  writeFileSync(transcriptPath, text);

  // 顺手换一个服务器报告页链接：报告页有四象限图和语义互动网络图，
  // 飞书云文档只有纯文本，复现不了那两张图。
  //
  // 上传失败**不影响分析结果**——publishReportToServer 内部已兜底（网络/超时/
  // 未配置都返回 null），调用方拿不到链接时退回文档或纯文本即可。
  let reportUrl = null;
  try {
    const published = await publishReportToServer(report, {
      meetingTitle: topic, startTime: null, feishuMeetingId: meetingId, transcript: text,
    });
    reportUrl = published?.url || null;
    if (reportUrl) onProgress({ step: 'published', url: reportUrl });
  } catch (e) {
    onProgress({ step: 'publish_failed', message: String(e?.message || e).slice(0, 120) });
  }

  return { meetingId: id, topic, report, reportPath, transcriptPath, speakerLines, reportUrl };
}

const PUBLISHED_LEDGER = join(STATE_DIR, 'published-docs.json');

function readPublished() {
  try { return JSON.parse(readFileSync(PUBLISHED_LEDGER, 'utf8')); } catch { return {}; }
}

/**
 * 把报告发成飞书云文档，作为卡片按钮的落点。
 * 幂等：同一场会议 + 同一个区域结论只创建一次，重复推送复用已有文档。
 */
export function publishReportDoc(report, { meetingTitle, startTime, reportPath }) {
  const zone = report.teamState?.zoneLabel || report.teamState?.zone || '未定位';
  const key = reportPath || `${meetingTitle || 'meeting'}::${zone}`;
  const ledger = readPublished();
  if (ledger[key]?.url) return { ...ledger[key], reused: true };

  const markdown = renderReportDoc(report, { meetingTitle, startTime });
  const doc = createDoc({
    title: `小组会议动力分析报告${meetingTitle ? ` · ${meetingTitle}` : ''}`,
    markdown,
  });
  ledger[key] = { url: doc.url, documentId: doc.documentId, at: new Date().toISOString(), meetingTitle, zone };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PUBLISHED_LEDGER, JSON.stringify(ledger, null, 2));
  return { ...ledger[key], reused: false };
}

/**
 * 推送报告到飞书（幂等）。
 *
 * 形态与 teaming-bot 线上一致：**极简交互卡片**（会议名称 + 按钮）。
 * 没有传入 reportUrl 时，会先把报告发成飞书云文档，再把文档链接放进按钮——
 * 这样本地链路也有"点击查看报告"的落点。
 */
/**
 * 组装报告卡片但**不发送**——供「宿主自己投递」的场景使用。
 *
 * 背景（2026-10-15 在豆包账号的豆包工作里实测）：MCP 自己那套 lark-cli
 * 授权的可能是本机另一个账号，于是 teaming_push_report 推不到当前用户；
 * 宿主改用自己租户的飞书能力发送时，它只能自己拼卡片——卡片样式于是
 * 和线上团队 bot 发的不一致。
 *
 * 解法：**卡片 JSON 由 MCP 出（唯一内容来源），宿主只负责投递。**
 */
export async function buildReportCard(report, {
  meetingTitle, reportUrl, startTime, feishuMeetingId, transcript, reportPath,
} = {}) {
  // 报告链接的三级优先：显式传入 > 服务器报告页 > 飞书文档兜底
  let url = reportUrl || null;
  let source = reportUrl ? 'explicit' : null;

  if (!url) {
    const published = await publishReportToServer(report, { meetingTitle, startTime, feishuMeetingId, transcript });
    if (published?.url) { url = published.url; source = 'server'; }
  }
  if (!url) {
    url = publishReportDoc(report, { meetingTitle, startTime, reportPath }).url;
    source = 'feishu_doc';
  }

  return {
    card: renderReportCard(report, { meetingTitle, reportUrl: url }),
    reportUrl: url,
    reportUrlSource: source,
  };
}

export async function pushReport(report, opts = {}) {
  const { chatId, userId, meetingTitle } = opts;
  const { card, reportUrl: url, reportUrlSource: source } = await buildReportCard(report, opts);
  const zone = report.teamState?.zoneLabel || report.teamState?.zone || '未定位';
  const idem = `teaming-${safeName(meetingTitle || 'meeting')}-${safeName(zone)}`.slice(0, 50);
  const sent = sendMessage({ chatId, userId, card, idempotencyKey: idem });
  return { ...sent, reportUrl: url, reportUrlSource: source };
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
    pushed = await pushReport(result.report, {
      chatId, userId, meetingTitle: result.topic,
      startTime: result.startTime, feishuMeetingId: result.meetingId,
      transcript: result.transcript, reportPath: result.reportPath,
    });
  }
  return { skipped: false, ...result, pushed };
}

/**
 * 列出近期会议，并标注**能不能真的做分析**。
 *
 * 产品只认妙记转录稿，所以判断依据是「有妙记 token 且妙记可读」，
 * **不能用"有智能纪要"来充数**——那种会议分析不了。
 * 默认只做便宜判断（详情接口会给 minuteDenied）；verify=true 时逐场实测取稿。
 */
export async function listMeetingsWithEligibility({ days = 30, query = '', verify = false } = {}) {
  const meetings = searchMeetings({ days, query });
  // 一次批量取详情，避免 N+1（实测 15 场逐场查要 12 秒，批量 1 秒内）
  // 批量失败时退回逐场：宁可慢，也不能让整份清单静默降级成"全都不可分析"。
  let details = new Map();
  try {
    details = await meetingDetailsBatch(meetings.map((m) => m.meetingId));
  } catch (batchError) {
    process.stderr.write(`[warn] 批量取会议详情失败，退回逐场查询：${
      String(batchError?.message || batchError).split('\n')[0]}\n`);
    for (const m of meetings) {
      try {
        const d = meetingDetail(m.meetingId);
        if (d) details.set(m.meetingId, d);
      } catch { /* 单场失败就跳过该场，不影响其他场 */ }
    }
  }

  const out = [];
  for (const m of meetings) {
    const detail = details.get(m.meetingId) || null;
    const hasMinute = Boolean(detail?.minuteToken);
    const minuteReadable = hasMinute && !detail.minuteDenied;

    let analyzable = minuteReadable;
    let reason = minuteReadable ? null
      : !hasMinute ? 'no_minute'
        : 'minute_permission_denied';

    if (verify && analyzable) {
      try {
        const t = fetchTranscript({ minuteToken: detail.minuteToken, topic: detail.topic });
        const turns = t.split('\n').filter((l) => /^.{1,48}?\s+\d{1,2}:\d{2}/.test(l)).length;
        analyzable = turns >= 4;
        if (!analyzable) reason = 'transcript_too_short';
      } catch {
        analyzable = false;
        reason = 'transcript_unavailable';
      }
    }

    out.push({
      meetingId: m.meetingId,
      title: detail?.topic || m.title,
      startTime: detail?.startTime || null,
      hasMinute,
      minuteReadable,
      analyzable,
      reason,
    });
  }
  return out;
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
