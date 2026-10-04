#!/usr/bin/env node
/**
 * teaming —— 会议动力分析 CLI
 *
 * 命令：
 *   doctor                     自检（只读）
 *   meetings [--days N]        列出近期会议（只读）
 *   transcript <meetingId>     取逐字稿（只读）
 *   analyze <meetingId>        取数 + 分析
 *   push <报告.json>           推送飞书
 *   self-chat                  查出"和自己单聊"的 chat_id（推送用）
 *   watch                      监听妙记生成事件 → 自动分析 → 自动推送
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

import { searchMeetings, meetingDetail, fetchTranscript, findSelfChatId, LarkError } from './lark.mjs';
import { analysisReadiness } from './analysis.mjs';
import { renderReportMarkdown } from './render.mjs';
import { analyzeMeeting, pushReport, handleMinuteEvent } from './pipeline.mjs';
import { writeJob } from './jobs.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    flags[k] = v;
  } else positional.push(argv[i]);
}

const log = (m) => process.stderr.write(`${m}\n`);
const out = (m) => process.stdout.write(`${m}\n`);
function die(msg, code = 1) { log(`\n[错误] ${msg}`); process.exit(code); }

function parseMinutes(v) {
  if (v === undefined || v === true) return 30;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return 30;
  return String(v).includes('m') ? n / 60 : n;
}

// ─────────────────────────── 命令 ───────────────────────────

function cmdDoctor() {
  const checks = [];
  const add = (name, ok, extra = '') => checks.push({ name, status: ok ? 'OK' : 'FAIL', extra });

  let version = '';
  try {
    version = execFileSync(process.env.LARK_CLI || 'lark-cli', ['--version'], { encoding: 'utf8' }).trim();
    add('lark-cli 可用', true, version);
  } catch {
    add('lark-cli 可用', false, '未安装或不在 PATH；可用 LARK_CLI 指定绝对路径');
  }

  let authOk = false; let who = '';
  try {
    const s = JSON.parse(execFileSync(process.env.LARK_CLI || 'lark-cli', ['auth', 'status'], { encoding: 'utf8' }));
    authOk = s?.identities?.user?.status === 'ready';
    who = s?.identities?.user?.userName || '';
    const scopes = s?.identities?.user?.scope || '';
    add('飞书已授权', authOk, who);
    add('会议搜索权限', scopes.includes('vc:meeting.search:read'));
    add('妙记读取权限', scopes.includes('minutes:minutes:readonly') || scopes.includes('minutes:minutes.basic:read'));
  } catch {
    add('飞书已授权', false, '执行 lark-cli auth login --recommend');
  }

  const ready = analysisReadiness();
  add('分析引擎已构建', ready.problems.every((p) => !p.includes('引擎')), ready.enginePath);
  add('分析凭证可用', ready.problems.every((p) => !p.includes('凭证')), '');

  const failed = checks.filter((c) => c.status === 'FAIL');
  if (flags.json) { out(JSON.stringify({ ok: failed.length === 0, checks }, null, 2)); process.exit(failed.length ? 1 : 0); }

  const w = Math.max(...checks.map((c) => c.name.length));
  log('\n=== teaming doctor ===');
  for (const c of checks) log(`  ${c.status.padEnd(5)} ${c.name.padEnd(w)} ${c.extra}`);
  log(failed.length ? `\n${failed.length} 项未通过。` : '\n全部通过，可以开始使用。');
  for (const p of ready.problems) log(`  · ${p}`);
  process.exit(failed.length ? 1 : 0);
}

function cmdMeetings() {
  const list = searchMeetings({ days: parseMinutes(flags.days), query: flags.query || '' });
  if (flags.json) { out(JSON.stringify({ meetings: list }, null, 2)); return; }
  log(`共 ${list.length} 场：\n`);
  for (const m of list) {
    const tags = [m.hasRecording ? '有录制' : '', m.hasDoc ? '有智能纪要' : ''].filter(Boolean).join('+') || '无产物';
    log(`  ${m.meetingId}  ${m.title.slice(0, 30).padEnd(32)} ${tags}`);
  }
}

function cmdTranscript() {
  const id = positional[0] || die('用法：teaming transcript <meetingId> [--out 文件]');
  const d = meetingDetail(id);
  if (!d) die(`找不到会议 ${id}。`);
  const t = fetchTranscript(d);
  if (flags.out) { writeFileSync(flags.out, t); log(`已写入 ${flags.out}`); }
  else out(t);
}

async function cmdAnalyze() {
  const id = positional[0] || die('用法：teaming analyze <meetingId> [--json] [--job-id <id>]');
  const jobId = flags['job-id'];
  if (jobId) writeJob(jobId, { status: 'running', meetingId: id, startedAt: new Date().toISOString(), pid: process.pid });
  try {
    const r = await analyzeMeeting(id, {
      onProgress: (e) => {
        if (e.step === 'detail') log(`[2/4] ${e.detail.topic}（${e.detail.startTime}）`);
        else if (e.step === 'note') log(`      ${e.message}`);
        else if (e.step === 'transcript') log(`[3/4] 逐字稿 ${e.turns} 条发言`);
        else if (e.step === 'analyzed') log(`[4/4] 分析完成（${e.seconds} 秒）`);
      },
    });
    const zone = r.report.teamState?.zoneLabel || r.report.teamState?.zone || '未定位';
    if (jobId) {
      writeJob(jobId, {
        status: 'done', finishedAt: new Date().toISOString(),
        reportPath: r.reportPath, transcriptPath: r.transcriptPath, topic: r.topic, zone,
      });
    }
    log(`\n区域定位：${zone}\n报告：${r.reportPath}\n逐字稿：${r.transcriptPath}`);
    if (flags.json) out(JSON.stringify({ reportPath: r.reportPath, transcriptPath: r.transcriptPath, zone, topic: r.topic, meetingId: r.meetingId }));
  } catch (e) {
    if (jobId) {
      writeJob(jobId, {
        status: 'failed', finishedAt: new Date().toISOString(),
        error: String(e?.message || e).slice(0, 500), kind: e?.kind || null,
      });
    }
    throw e;
  }
}

function cmdPush() {
  const p = positional[0] || die('用法：teaming push <报告.json> [--chat <chat_id> | --to <open_id>]');
  const { fillChat } = parseTarget();
  const report = JSON.parse(readFileSync(p, 'utf8'));
  if (flags['dry-run']) { out(renderReportMarkdown(report, { meetingTitle: flags.title, reportUrl: flags.url })); return; }
  const r = pushReport(report, { ...fillChat, meetingTitle: flags.title, reportUrl: flags.url });
  log(`已推送${r.messageId ? `（message_id=${r.messageId}）` : ''}`);
}

function cmdSelfChat() {
  const id = findSelfChatId();
  if (!id) die('找不到和你自己的单聊会话。可在飞书里给自己发一条消息后重试。');
  if (flags.json) { out(JSON.stringify({ chatId: id })); return; }
  log(id);
}

function cmdWatch() {
  const { fillChat } = parseTarget();
  if (!fillChat.chatId && !fillChat.userId) {
    const id = findSelfChatId();
    if (id) { fillChat.chatId = id; log(`[默认推送目标] 和自己的单聊 ${id}`); }
    else log('[提示] 未指定 --chat/--to，本次只分析、不推送');
  }
  log('监听 minutes.minute.generated_v1（Ctrl+C 退出）…');
  log('注意：本进程退出后飞书侧订阅会注销，期间的妙记事件不会补发。');
  log('     产品环境应改为「订阅一次 + 服务端常驻消费者」。');

  const child = spawn(process.env.LARK_CLI || 'lark-cli',
    ['event', 'consume', 'minutes.minute.generated_v1', '--as', 'user'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      handleMinuteEvent(ev, {
        ...fillChat,
        onProgress: (e) => log(`  · ${e.step} ${e.message || e.topic || ''}`),
      })
        .then((r) => log(`[结果] ${JSON.stringify(r.skipped ? r : { zone: r.report?.teamState?.zoneLabel, topic: r.topic })}`))
        .catch((err) => log(`[失败] event=${ev.event_id || '?'} ${err.message}`));
    }
  });
  child.on('exit', (code) => log(`\n监听退出（code ${code}）`));
}

function parseTarget() {
  const fillChat = {};
  if (flags.chat) fillChat.chatId = flags.chat;
  if (flags.to) fillChat.userId = flags.to;
  return { fillChat };
}

// ─────────────────────────── 入口 ───────────────────────────

const USAGE = `
teaming —— 会议动力分析 CLI

  teaming doctor                        自检（只读）
  teaming meetings [--days 30]          列出近期会议（只读）
  teaming transcript <meetingId>        取逐字稿（只读）
  teaming analyze <meetingId> [--json]  取数 + 分析
  teaming push <报告.json> [--chat ID]  推送飞书（--dry-run 预览）
  teaming self-chat                     查出自己的 chat_id
  teaming watch [--chat ID]             监听妙记生成事件并自动分析推送

环境变量：
  LARK_CLI         lark-cli 路径
  TEAMING_ENGINE   分析引擎路径（默认 dist/engine/...）
  TEAMING_OUT      产物目录（默认 .out/）
  DOUBAO_API_KEY   分析所用模型凭证
`;

async function main() {
  switch (cmd) {
    case 'doctor': cmdDoctor(); break;
    case 'meetings': cmdMeetings(); break;
    case 'transcript': cmdTranscript(); break;
    case 'analyze': await cmdAnalyze(); break;
    case 'push': cmdPush(); break;
    case 'self-chat': cmdSelfChat(); break;
    case 'watch': cmdWatch(); break;
    default: out(USAGE); process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  if (e instanceof LarkError) die(e.message);
  die(e?.stack || String(e));
});
