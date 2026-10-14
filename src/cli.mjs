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

import { meetingDetail, fetchTranscript, findSelfChatId, larkReadiness, LarkError } from './lark.mjs';
import { analysisReadiness, providerSummary } from './analysis.mjs';
import { renderReportCard } from './render.mjs';
import { analyzeMeeting, analyzeProvidedTranscript, pushReport, handleMinuteEvent, listMeetingsWithEligibility } from './pipeline.mjs';
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

  // 授权判定复用 larkReadiness()，只留一个判据。
  //
  // 这里曾经自己判一遍 `status === 'ready'`，而 lark.mjs 里也判一遍，
  // 两处都会把正常的 needs_refresh 误判成"未授权"。
  // 修 lark.mjs 后本处仍报 FAIL，就是因为漏了这个副本。
  const readiness = larkReadiness();
  const scopes = readiness.scopes || '';
  add('飞书已授权', Boolean(readiness.userName), readiness.userName || '执行 lark-cli auth login --recommend');
  add('会议搜索权限', Boolean(readiness.userName) && scopes.includes('vc:meeting.search:read'));
  add('妙记读取权限',
    Boolean(readiness.userName)
    && (scopes.includes('minutes:minutes:readonly') || scopes.includes('minutes:minutes.basic:read')));

  const ready = analysisReadiness();
  add('分析引擎已构建', ready.problems.every((p) => !p.includes('引擎')), ready.enginePath);
  add('分析凭证可用', ready.problems.every((p) => !p.includes('凭证')), '');
  // 端点过去完全不展示，而引擎缺它会直接降级成 basic_fallback——
  // 用户看到"凭证可用"却拿不到完整报告。这里把实际生效的端点摆出来。
  const provider = providerSummary();
  add('模型端点', true, `${provider.baseUrl}${provider.baseUrlIsDefault ? '（默认，可用 DOUBAO_BASE_URL 覆盖）' : ''}`);
  add('分析模型', true, provider.model || '');

  const failed = checks.filter((c) => c.status === 'FAIL');
  if (flags.json) { out(JSON.stringify({ ok: failed.length === 0, checks }, null, 2)); process.exit(failed.length ? 1 : 0); }

  const w = Math.max(...checks.map((c) => c.name.length));
  log('\n=== teaming doctor ===');
  for (const c of checks) log(`  ${c.status.padEnd(5)} ${c.name.padEnd(w)} ${c.extra}`);
  log(failed.length ? `\n${failed.length} 项未通过。` : '\n全部通过，可以开始使用。');
  for (const p of ready.problems) log(`  · ${p}`);
  process.exit(failed.length ? 1 : 0);
}

async function cmdMeetings() {
  const list = await listMeetingsWithEligibility({
    days: parseMinutes(flags.days), query: flags.query || '', verify: flags.verify === true,
  });
  if (flags.json) { out(JSON.stringify({ meetings: list }, null, 2)); return; }
  const ok = list.filter((m) => m.analyzable).length;
  log(`共 ${list.length} 场，其中 ${ok} 场可分析：\n`);
  for (const m of list) {
    const mark = m.analyzable ? '✅' : '❌';
    const why = m.reason ? `  (${m.reason})` : '';
    log(`  ${mark} ${m.meetingId}  ${m.title.slice(0, 26).padEnd(28)}${why}`);
  }
  log('\n只认妙记文字转录稿；no_minute=没录制，minute_permission_denied=妙记无权限。');
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

/**
 * 分析**由宿主提供的**逐字稿——全程不碰飞书。
 *
 * 供新架构使用：宿主（豆包工作/WorkBuddy）自己取数，把逐字稿交给我们分析。
 * 逐字稿走文件而不是命令行参数——它可能很长，argv 放不下。
 */
async function cmdAnalyzeTranscript() {
  const file = flags.file || positional[0]
    || die('用法：teaming analyze-transcript --file <逐字稿路径> [--title <标题>] [--meeting-id <id>] [--job-id <id>]');
  const jobId = flags['job-id'];
  const title = flags.title || '会议';
  const meetingId = flags['meeting-id'] || null;

  if (jobId) {
    writeJob(jobId, {
      status: 'running', meetingId: meetingId || jobId,
      startedAt: new Date().toISOString(), pid: process.pid,
    });
  }

  try {
    const transcript = readFileSync(file, 'utf8');
    const r = await analyzeProvidedTranscript({
      transcript, title, meetingId,
      onProgress: (e) => {
        if (e.step === 'transcript') log(`[1/2] 逐字稿 ${e.turns} 条发言 / ${e.chars} 字`);
        else if (e.step === 'analyzed') log(`[2/2] 分析完成（${e.seconds} 秒）`);
        else if (e.step === 'published') log(`      报告页：${e.url}`);
        else if (e.step === 'publish_failed') log(`      报告页上传失败（不影响分析）：${e.message}`);
      },
    });
    const zone = r.report.teamState?.zoneLabel || r.report.teamState?.zone || '未定位';
    if (jobId) {
      writeJob(jobId, {
        status: 'done', finishedAt: new Date().toISOString(),
        reportPath: r.reportPath, transcriptPath: r.transcriptPath, topic: r.topic, zone,
        reportUrl: r.reportUrl || null,
      });
    }
    log(`\n区域定位：${zone}\n报告：${r.reportPath}${r.reportUrl ? `\n报告页：${r.reportUrl}` : ''}`);
    if (flags.json) {
      out(JSON.stringify({
        reportPath: r.reportPath, transcriptPath: r.transcriptPath,
        zone, topic: r.topic, meetingId: r.meetingId, speakerLines: r.speakerLines,
        reportUrl: r.reportUrl || null,
      }));
    }
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

async function cmdPush() {
  const p = positional[0] || die('用法：teaming push <报告.json> [--chat <chat_id> | --to <open_id>]');
  const { fillChat } = parseTarget();
  const report = JSON.parse(readFileSync(p, 'utf8'));
  if (flags['dry-run']) {
    out(JSON.stringify(renderReportCard(report, { meetingTitle: flags.title, reportUrl: flags.url }), null, 2));
    return;
  }
  const r = await pushReport(report, { ...fillChat, meetingTitle: flags.title, reportUrl: flags.url });
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
    case 'meetings': await cmdMeetings(); break;
    case 'transcript': cmdTranscript(); break;
    case 'analyze': await cmdAnalyze(); break;
    case 'analyze-transcript': await cmdAnalyzeTranscript(); break;
    case 'push': await cmdPush(); break;
    case 'self-chat': cmdSelfChat(); break;
    case 'watch': cmdWatch(); break;
    default: out(USAGE); process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  if (e instanceof LarkError) die(e.message);
  die(e?.stack || String(e));
});
