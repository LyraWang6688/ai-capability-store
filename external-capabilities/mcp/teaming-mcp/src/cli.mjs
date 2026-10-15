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
import { CONFIG_PATH, readStoredConfig, writeStoredConfig, applyStoredConfigToEnv, isEnrolled } from './config.mjs';
import { writeJob } from './jobs.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
// 启动时先应用接入码换来的配置（不覆盖已显式设置的环境变量）
applyStoredConfigToEnv();

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
  // 三种状态：OK / FAIL / SKIP。
  // SKIP 用于「这一项在当前架构下不是必需」——它不该拉低通过率，
  // 否则用户会照着一个本来不需要的 FAIL 去折腾。
  const add = (name, ok, extra = '', { skip = false } = {}) => checks.push({
    name, status: skip ? 'SKIP' : (ok ? 'OK' : 'FAIL'), extra,
  });

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
  //
  // 2026-10-14 追加：新架构下这三项**不是必需**的。
  //
  // 取数与推送已交给宿主（豆包工作用自己的飞书能力），MCP 只做分析，
  // 所以没授权也能跑通。但 doctor 仍然把它们报成 FAIL，用户会照着一个
  // 本来不需要的错误去折腾 lark-cli 授权——又一个「系统说错话」。
  //
  // 判据：已通过接入码配好（isEnrolled）就说明走的是新架构，标 SKIP。
  const enrolled = isEnrolled();
  const readiness = larkReadiness();
  const scopes = readiness.scopes || '';
  const authorized = Boolean(readiness.userName);
  const hasSearchScope = authorized && scopes.includes('vc:meeting.search:read');
  const hasMinutesScope = authorized
    && (scopes.includes('minutes:minutes:readonly') || scopes.includes('minutes:minutes.basic:read'));

  /**
   * 新架构下这三项**不是必需**的：没通过时标 SKIP 而不是 FAIL，
   * 免得用户照着一个本来不需要的错误去折腾 lark-cli 授权。
   *
   * **但通过时必须显示 OK。** 曾经只要配了接入码就无条件标 SKIP，
   * 于是出现「SKIP 飞书已授权 王颖」——宿主 AI 读到后报告
   * "飞书授权：已登录，身份为王颖"，而新架构下 MCP 根本不该碰飞书。
   * 一个"通过"的事实被标成 SKIP，两种读法都是错的。
   */
  const optional = (passed) => (passed || !enrolled ? {} : { skip: true });
  const reason = (passed, fallback) => {
    if (passed) return '';
    return enrolled ? '新架构下由宿主取数，MCP 不需要飞书授权' : fallback;
  };

  add('飞书已授权', authorized,
    readiness.userName || reason(authorized, '执行 lark-cli auth login --recommend'),
    optional(authorized));
  add('会议搜索权限', hasSearchScope,
    hasSearchScope ? '' : reason(hasSearchScope, '需要 vc:meeting.search:read'), optional(hasSearchScope));
  add('妙记读取权限', hasMinutesScope,
    hasMinutesScope ? '' : reason(hasMinutesScope, '需要妙记读取权限'), optional(hasMinutesScope));

  const ready = analysisReadiness();
  // 2026-10-15 起分析在服务器跑，本机只要一个 host token。
  // 以前这里展示"模型端点/模型名"，现在那是服务器的配置，本机看不到也不必看。
  add('分析服务器可达', true, ready.apiBaseUrl);
  add('接入凭证可用', ready.ready, ready.ready ? `（${ready.tokenFile}）` : '');

  const failed = checks.filter((c) => c.status === 'FAIL');
  const skipped = checks.filter((c) => c.status === 'SKIP');
  if (flags.json) {
    out(JSON.stringify({ ok: failed.length === 0, checks, skipped: skipped.map((c) => c.name) }, null, 2));
    process.exit(failed.length ? 1 : 0);
  }

  const w = Math.max(...checks.map((c) => c.name.length));
  log('\n=== teaming doctor ===');
  for (const c of checks) log(`  ${c.status.padEnd(5)} ${c.name.padEnd(w)} ${c.extra}`);
  if (failed.length) {
    log(`\n${failed.length} 项未通过。`);
  } else if (skipped.length) {
    log(`\n可以开始使用。${skipped.length} 项已跳过（当前架构下不需要）。`);
  } else {
    log('\n全部通过，可以开始使用。');
  }
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
 * 用接入码换回本机配置——用户侧只需要这一个命令。
 *
 * 换回的东西写进 ~/.teaming-mcp/config.json（0600），之后 MCP 启动时自动读取，
 * 用户不必再在连接器里手填 token、端点、模型 key。
 *
 * 为什么要有它：手工配 5~7 个环境变量，还要把我们的模型 key 抄进去，
 * 对非技术用户几乎不可完成；而且服务器无法据此判断"这份报告属于谁"。
 */
async function cmdSetup() {
  const code = flags.code || positional[0];
  if (!code) die('用法：teaming setup --code <接入码>\n  接入码向管理员索取，形如 KNTX7UCR（不含 0/O、1/I/L）。');

  const serverUrl = (flags.server || process.env.TEAMING_SERVER_URL || 'https://meeting.bamamei.online')
    .replace(/\/+$/, '');
  const existing = readStoredConfig();
  const installationId = existing?.installationId
    || `inst_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  log(`正在兑换接入码 ${String(code).toUpperCase()} …`);
  let payload;
  try {
    const res = await fetch(`${serverUrl}/api/host/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: String(code).toUpperCase(), installationId }),
      signal: AbortSignal.timeout(20000),
    });
    payload = await res.json().catch(() => null);
    if (!res.ok || !payload?.ok) {
      die(`兑换失败：${payload?.error || `HTTP ${res.status}`}${payload?.hint ? `\n  ${payload.hint}` : ''}`);
    }
  } catch (e) {
    die(`连不上服务器（${serverUrl}）：${e?.message || e}\n  请检查网络，或用 --server 指定地址。`);
  }

  const path = writeStoredConfig({
    serverUrl,
    hostToken: payload.hostToken,
    integrationId: payload.integrationId,
    integrationName: payload.integrationName ?? null,
    installationId,
    analysis: {
      apiKey: payload.analysis?.apiKey ?? null,
      baseUrl: payload.analysis?.baseUrl ?? null,
      model: payload.analysis?.model ?? null,
    },
    enrolledAt: new Date().toISOString(),
  });

  log('');
  log(`✅ 配置已写入 ${path}`);
  log(`   归属集成：${payload.integrationName || payload.integrationId}`);
  // 服务器下发的 model/baseUrl 不再需要写进本机：分析在服务器跑
  log('   分析方式：调用服务器（本机不需要任何模型配置）');
  log('');
  log('接下来在宿主的连接器里只需保留启动配置（command 与 args），');
  log('不要再手工填 TEAMING_HOST_TOKEN —— 本文件里的优先。');
  if (flags.json) out(JSON.stringify({ ok: true, configPath: path, integrationId: payload.integrationId }));
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

新装第一步：
  teaming setup --code <接入码>          用接入码配好本机（凭证 / 端点 / 模型）

日常命令：
  teaming doctor                        自检（只读）
  teaming meetings [--days 30]          列出近期会议（只读）
  teaming transcript <meetingId>        取逐字稿（只读）
  teaming analyze <meetingId> [--json]  取数 + 分析（走 lark-cli，需飞书授权）
  teaming analyze-transcript --file <逐字稿> [--title <标题>]
                                        只分析，不碰飞书（宿主供稿用）
  teaming push <报告.json> [--chat ID]  推送飞书（--dry-run 预览）
  teaming self-chat                     查出自己的 chat_id
  teaming watch [--chat ID]             监听妙记生成事件并自动分析推送

环境变量（可选；setup 写入 ~/.teaming-mcp/config.json 后通常不用配）：
  LARK_CLI         lark-cli 路径
  TEAMING_OUT        产物目录
  TEAMING_HOST_TOKEN 接入码换来的凭证（也可放 ~/.teaming-mcp/host-token）
  TEAMING_API_BASE_URL 分析服务器地址（默认 https://meeting.bamamei.online）
  TEAMING_TOKEN_FILE 凭证文件路径（默认 ~/.teaming-mcp/host-token）
  ★ 无需模型配置：分析在服务器侧完成
`;

/**
 * 退出码约定：
 *   无参数 / --help / -h / help  → 打印用法，退出 0（这是用户主动要看的）
 *   未知命令                      → 打印用法，退出 1（这是调用出错）
 *   --version                    → 打印版本，退出 0
 *
 * 曾经 --help 和未知命令都退出 1——用户查帮助却拿到失败退出码，
 * 在脚本里会被当成错误。
 */
const HELP_CMDS = new Set(['--help', '-h', 'help']);

async function main() {
  switch (cmd) {
    case 'doctor': cmdDoctor(); break;
    case 'meetings': await cmdMeetings(); break;
    case 'transcript': cmdTranscript(); break;
    case 'analyze': await cmdAnalyze(); break;
    case 'analyze-transcript': await cmdAnalyzeTranscript(); break;
    case 'setup': await cmdSetup(); break;
    case 'push': await cmdPush(); break;
    case 'self-chat': cmdSelfChat(); break;
    case 'watch': cmdWatch(); break;
    case '--version': case '-v': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      out(pkg.version);
      break;
    }
    default:
      out(USAGE);
      // 主动查帮助不算失败；只有未知命令才是
      process.exit(!cmd || HELP_CMDS.has(cmd) ? 0 : 1);
  }
}

main().catch((e) => {
  if (e instanceof LarkError) die(e.message);
  die(e?.stack || String(e));
});
