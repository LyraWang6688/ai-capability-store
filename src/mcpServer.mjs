#!/usr/bin/env node
/**
 * teaming-mcp —— 会议动力分析的 stdio MCP 服务
 *
 * 设计要点：
 * - 零运行时依赖：手写 JSON-RPC，避免宿主环境装不上包
 * - stdout 绝对纯净：第一件事就把 console.log 重定向到 stderr
 * - 传引用不传正文：报告正文只回摘要 + 本地路径，不灌进模型上下文
 * - 只读工具标 readOnlyHint，并提供一个无副作用的 doctor（生态准入要求）
 *
 * 宿主配置：
 *   豆包工作 → 技能·连接器·伙伴 → 添加 → 新建自定义连接器 → STDIO
 *     command: /usr/local/bin/node  （必须绝对路径，GUI 不继承 PATH）
 *     args:    <本文件绝对路径>
 *     环境变量: DOUBAO_API_KEY=...
 *   WorkBuddy → ~/.workbuddy/mcp.json 的 mcpServers 里加一条
 */
const realWrite = process.stdout.write.bind(process.stdout);
console.log = (...a) => process.stderr.write(`${a.map(String).join(' ')}\n`);
console.info = console.log; console.warn = console.log; console.debug = console.log;

import { readFileSync, appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = process.env.TEAMING_CLI || join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

// 启动时应用接入码换来的配置（环境变量优先，文件只补空缺）
applyStoredConfigToEnv();

/**
 * 连接诊断日志。
 *
 * 为什么需要：宿主报"连不上"时，stdio MCP **没有任何可观测性**——
 * 进程活着但在等 stdin，宿主说握手失败，双方都不留痕，只能反复重启碰运气。
 * 2026-10-14 在豆包工作里就卡在这个状态：`ps` 显示进程健康，
 * 但宿主侧报连接层故障，无从判断卡在哪一步。
 *
 * 原则：
 * - **只写文件**，一个字节都不进 stdout（stdout 只走 JSON-RPC）
 * - 只记方法与结果，**绝不记参数正文**（可能含会议原文）
 * - 自己出错绝不抛，日志不能反过来搞挂服务
 */
// 日志走 paths.mjs 的解析：npm 全局安装时包目录在 node_modules 里，
// 写在那儿既不合规（升级/卸载会连日志一起没），也容易没权限。
// 之前只把「数据目录」接进了 paths.mjs，漏了这一处。
const LOG_PATH = process.env.TEAMING_MCP_LOG
  || join(resolveStateDir(), 'mcp.log');
const LOG_MAX_BYTES = 1024 * 1024;

function trace(event, detail = {}) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    try {
      if (statSync(LOG_PATH).size > LOG_MAX_BYTES) writeFileSync(LOG_PATH, '');
    } catch { /* 文件不存在，无需轮转 */ }
    appendFileSync(LOG_PATH, `${JSON.stringify({ t: new Date().toISOString(), event, ...detail })}\n`);
  } catch { /* 日志失败不影响服务 */ }
}

trace('mcp_server_started', {
  pid: process.pid,
  cwd: process.cwd(),
  protocol: process.argv.slice(2).join(' '),
  // 只记"有没有"，不记值
  hasDoubaoKey: Boolean(process.env.DOUBAO_API_KEY || process.env.LLM_API_KEY || process.env.ARK_API_KEY),
  hasBaseUrl: Boolean(process.env.DOUBAO_BASE_URL || process.env.LLM_BASE_URL || process.env.ARK_BASE_URL),
  hasLarkCli: Boolean(process.env.LARK_CLI),
});

process.on('uncaughtException', (e) => trace('uncaught_exception', { message: String(e?.message || e) }));
process.on('unhandledRejection', (e) => trace('unhandled_rejection', { message: String(e?.message || e) }));

import { analysisReadiness } from './analysis.mjs';
import { larkReadiness, findSelfChatId } from './lark.mjs';
import { reportDigest } from './render.mjs';
import { readReport, pushReport, buildReportCard, listMeetingsWithEligibility } from './pipeline.mjs';
import { normalizeTranscript } from './transcript.mjs';
import { newJobId, writeJob, readJob, waitForJob, pruneJobs, JOBS_DIR } from './jobs.mjs';
import { applyStoredConfigToEnv } from './config.mjs';
import { resolveStateDir } from './paths.mjs';

// 版本号从 package.json 读：曾写死成 '0.1.0'，发到 0.1.1 后 initialize 里报的还是旧版本
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SERVER_INFO = { name: 'teaming', version: PKG_VERSION };
const SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

const TOOLS = [
  {
    name: 'teaming_doctor',
    description:
      '体检：检查飞书授权、分析凭证、引擎构建是否就绪。无副作用。'
      + '什么时候用：用户反馈「查不到会议」「分析失败」「连接器没反应」时先跑这个。'
      + '什么时候不要用：正常查询时不需要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'teaming_list_meetings',
    description:
      '列出用户近期的飞书会议，并标注每场是否有录制（妙记）或智能纪要。'
      + '什么时候用：用户问「我最近开了哪些会」「哪场会有逐字稿」。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, description: '回溯天数，默认 30' },
        query: { type: 'string', description: '按标题关键词过滤，可省略' },
        verify: { type: 'boolean', description: '是否逐场实测能否取到转录稿（更准但更慢），默认 false' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'teaming_read_report',
    description:
      '读取一场会议已生成的分析报告摘要（区域定位、两个维度、最优先建议）。'
      + '什么时候用：用户问「上次那场会的团队氛围怎么样」。'
      + '只返回摘要；完整报告在 report_path 指向的本地文件里。',
    inputSchema: {
      type: 'object',
      properties: { meeting_id: { type: 'string', description: '会议 ID' } },
      required: ['meeting_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'teaming_analyze_meeting',
    description:
      '对一场会议做团队动力分析，产出四部分报告（团队状态定位／互动概览／未完成的对话与非共识／给领导者的建议）。'
      + '什么时候用：用户明确要求「分析这场会」「看看团队氛围」。'
      + '已分析过的会议会直接复用已有报告，不重复消耗（要重跑传 force=true）。'
      + '**本工具会尽快返回，不会一直等到分析结束。**'
      + '返回 status=running 时，必须用 teaming_job_status 轮询同一个 job_id 直到 status=done，'
      + '然后把报告摘要给用户；**不要重复调用本工具**（会重复排队）。'
      + '分析通常需要 60~120 秒，任务不会因为等待超时而丢失。',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: '会议 ID' },
        // 默认 0：立刻返回，绝不内联等待。
        // 2026-10-14 实测教训：这个 MCP 本身 10.4 秒就能返回（已用协议端到端计时确认），
        // 但宿主观测到的却是 70 秒——多出的 60 秒在宿主侧（疑似 macOS 沙箱对后台进程的调度挂起），
        // 于是无论内联等待设 45 还是 10，都会撞上宿主 60 秒的 tools/call 超时，
        // 用户看到"失败"，而分析其实早已跑完。默认 0 让工具调用只做「排队」这一件事，
        // 等待完全交给 teaming_job_status。
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: '最多内联等待多少秒，默认 0（立即返回）。除非你明确想等，否则不要传' },
        force: { type: 'boolean', description: '已有报告时是否强制重跑，默认 false' },
      },
      required: ['meeting_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'teaming_analyze_transcript',
    description:
      '直接分析**你提供的逐字稿**，产出四部分报告。'
      + '**本工具不访问飞书、不需要飞书授权，也不会因为「身份不匹配」而失败——'
      + '只要你自己能读到逐字稿，就应该优先用它。**'
      + '什么时候用：你自己（宿主）能用飞书能力搜到这场会并导出妙记文字稿；'
      + '或者用户直接粘贴了一段会议逐字稿要你分析。'
      + '判断方法：先用你自己的飞书能力搜一下这场会——搜得到就用本工具。'
      + '**注意：本工具用 MCP 自己的 lark-cli 身份去取数，那个身份和当前用户登录的账号可能不是同一个人。'
      + '如果取数时报「No read permission」，说明这场会议不属于本机授权的账号——'
      + '此时改用 teaming_analyze_transcript，由你自己取好逐字稿再传进来。**'
      + '逐字稿必须是**成员原始发言**（每行形如「姓名 MM:SS 发言内容」）；'
      + 'AI 摘要、会议纪要、待办列表都不算逐字稿，传了会被拒绝。'
      + '**本工具会尽快返回，不会一直等到分析结束。**'
      + '返回 status=running 时，用 teaming_job_status 轮询同一个 job_id 直到 status=done。',
    inputSchema: {
      type: 'object',
      properties: {
        transcript: {
          type: 'string',
          description: '逐字稿正文。可以是引擎格式的纯文本（每行「姓名 MM:SS 内容」），也可以是妙记导出的 HTML（会自动转换并剥掉标题）',
        },
        title: { type: 'string', description: '会议标题，用于报告命名与展示，默认「会议」' },
        meeting_id: { type: 'string', description: '会议 ID（可选）。不传则用逐字稿内容哈希做标识，同一份逐字稿不会重复分析' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: '最多内联等待多少秒，默认 0（立即返回）' },
      },
      required: ['transcript'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'teaming_push_report',
    description:
      '把一场会议的分析报告作为**交互卡片**推送到飞书。'
      + '什么时候用：用户说「把报告发我」「推送到飞书」「发我私信」时。'
      + '不传 chat_id 就推给用户自己（自动查和自己的单聊）。'
      + '推送是幂等的，重复调用不会产生重复消息。'
      + '**重要：本工具用的是 MCP 自己那套 lark-cli 授权，也就是【本机那个飞书账号】，'
      + '它和当前对话的用户可能不是同一个人。**'
      + '如果推送后用户说没收到，几乎一定是这个原因——'
      + '此时改用【你自己的】飞书发消息能力把报告发给用户，不要反复重试本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: '会议 ID' },
        chat_id: { type: 'string', description: '目标会话 ID；省略则推给用户自己' },
      },
      required: ['meeting_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'teaming_report_card',
    description:
      '取一份报告的【飞书交互卡片 JSON】——这是本产品统一的消息卡片样式。'
      + '**本工具不发送任何消息**，只把卡片交给你。'
      + '什么时候用：你要把报告以卡片形式发给用户，但 MCP 自己那套 lark-cli 授权'
      + '不是当前用户（例如用户用豆包账号、本机 lark-cli 是另一个人），'
      + '于是 teaming_push_report 推不到他。'
      + '拿到 card 后，用【你自己的】飞书发消息能力把它作为 interactive 消息发出去。'
      + '**不要自己设计卡片样式**——那样做出来的卡片和线上团队 bot 发的不一致。'
      + '能用 teaming_push_report 直接发（本机 lark-cli 就是当前用户）时，优先用那个。',
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: '会议 ID' },
        report_url: { type: 'string', description: '可选：报告页链接。不传则自动发布到服务器取链接' },
      },
      required: ['meeting_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'teaming_job_status',
    description:
      '查询一次分析任务的状态：running（后台仍在跑）／done（完成，含报告摘要）／failed（失败，含原因）。'
      + '什么时候用：teaming_analyze_meeting 返回 status=running 时，隔一会儿用本工具取结果。',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'teaming_analyze_meeting 返回的 job_id' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function callTool(name, args) {
  if (name === 'teaming_doctor') {
    const engine = analysisReadiness();
    const lark = larkReadiness();
    pruneJobs();
    const problems = [...lark.problems, ...engine.problems];
    return {
      ready: problems.length === 0,
      lark_cli: lark.version || null,
      feishu_user: lark.userName || null,
      engine_path: engine.enginePath,
      problems,
      hint: problems.length
        ? '按 problems 里每条后面的「下一步」处理后重试。'
        : `环境就绪（飞书身份 ${lark.userName}）。`,
    };
  }

  if (name === 'teaming_list_meetings') {
    const list = await listMeetingsWithEligibility({
      days: args.days || 30, query: args.query || '', verify: args.verify === true,
    });
    return {
      count: list.length,
      analyzable_count: list.filter((m) => m.analyzable).length,
      meetings: list.map((m) => ({
        meeting_id: m.meetingId,
        title: m.title,
        start_time: m.startTime,
        analyzable: m.analyzable,
        reason: m.reason,
      })),
      hint: '只能分析 analyzable=true 的会议——产品只认妙记的文字转录稿。'
        + 'reason=no_minute 表示没录制；minute_permission_denied 表示妙记无权限。',
    };
  }

  if (name === 'teaming_read_report') {
    const found = readReport(args.meeting_id);
    if (!found) {
      return {
        found: false,
        hint: '这场会议还没有分析报告。请先用 teaming_analyze_meeting 生成。',
      };
    }
    return { found: true, report_path: found.path, ...reportDigest(found.report) };
  }

  if (name === 'teaming_analyze_meeting') {
    const meetingId = args.meeting_id;

    // 已有报告直接复用，避免重复消耗与重复推送
    if (!args.force) {
      const existing = readReport(meetingId);
      if (existing) {
        return {
          status: 'done', reused: true, meeting_id: meetingId,
          report_path: existing.path, ...reportDigest(existing.report),
          hint: '该会议已有报告，直接复用。需要重跑请传 force=true。',
        };
      }
    }

    const jobId = newJobId();
    writeJob(jobId, { status: 'running', meetingId, startedAt: new Date().toISOString() });
    // 分离子进程：即使宿主断开、工具调用超时，分析也会跑完并落账本
    const child = spawn(process.execPath, [CLI, 'analyze', meetingId, '--job-id', jobId], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();

    const waitMs = Math.max(0, Math.min(600, Number.isFinite(args.wait_seconds) ? args.wait_seconds : 0)) * 1000;
    const job = await waitForJob(jobId, waitMs);

    if (job?.status === 'done') {
      const found = readReport(meetingId);
      return {
        status: 'done', job_id: jobId, meeting_id: meetingId,
        report_path: job.reportPath, zone: job.zone,
        ...(found ? reportDigest(found.report) : {}),
        hint: '需要在消息里呈现时，先读 report_path 再取舍，不要把全文塞回上下文。',
      };
    }
    if (job?.status === 'failed') {
      return {
        status: 'failed', job_id: jobId, error: clean(job.error),
        hint: job.kind === 'transcript_too_short' || job.kind === 'no_transcript'
          ? '这场会议缺少可用的逐字稿，换一场有逐字稿的会议。'
          : '可在终端执行 `teaming analyze <meetingId>` 看完整报错。',
      };
    }
    return {
      status: 'running', job_id: jobId, meeting_id: meetingId,
      hint: `分析在后台继续跑（通常 60~120 秒），不会因等待超时而丢失。`
        + `请稍后用 teaming_job_status 查 job_id=${jobId}。`,
    };
  }

  // 分析由调用方提供的逐字稿：全程不碰飞书（新架构的入口）
  if (name === 'teaming_analyze_transcript') {
    const transcript = args.transcript;
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return { status: 'failed', error: '没有拿到逐字稿正文。', hint: '把妙记文字转录稿原文传进 transcript。' };
    }

    // **先做一次本地校验**：不合格就当场拒绝。
    // 校验放在后台进程里也能拦住（analyze 之前就 normalize），但那样调用方要先拿到
    // running、再轮询才发现失败——体验差，还白起一个进程。
    try {
      normalizeTranscript(transcript);
    } catch (e) {
      return {
        status: 'failed',
        error: clean(e?.message || e),
        kind: e?.kind || null,
        hint: '逐字稿必须是成员原始发言（每行「姓名 MM:SS 内容」）。AI 摘要、会议纪要不能替代。',
      };
    }

    // 逐字稿内容哈希做标识，同一份内容重复调用会复用同一份报告。
    const title = String(args.title || '会议').trim() || '会议';
    const meetingId = args.meeting_id || null;
    const jobId = newJobId();
    const digest = createHash('sha256').update(transcript).digest('hex').slice(0, 12);
    const idForReuse = meetingId || `h${digest}`;
    if (!args.force) {
      const existing = readReport(idForReuse);
      if (existing) {
        return {
          status: 'done', reused: true, meeting_id: idForReuse,
          report_path: existing.path, ...reportDigest(existing.report),
          hint: '同一份逐字稿已有报告，直接复用。需要重跑请传 force=true。',
        };
      }
    }

    // 逐字稿走临时文件：它可能很长，argv 放不下
    const transcriptDir = join(dirname(JOBS_DIR), 'transcripts');
    let transcriptFile;
    try {
      mkdirSync(transcriptDir, { recursive: true });
      transcriptFile = join(transcriptDir, `${jobId}.txt`);
      writeFileSync(transcriptFile, transcript, 'utf8');
    } catch (e) {
      return { status: 'failed', error: `逐字稿落盘失败：${clean(e?.message || e)}` };
    }

    writeJob(jobId, {
      status: 'running', meetingId: idForReuse,
      startedAt: new Date().toISOString(),
    });
    const childArgs = [CLI, 'analyze-transcript', '--file', transcriptFile, '--title', title, '--job-id', jobId];
    if (meetingId) childArgs.push('--meeting-id', meetingId);
    const child = spawn(process.execPath, childArgs, {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();

    const waitMs = Math.max(0, Math.min(600, Number.isFinite(args.wait_seconds) ? args.wait_seconds : 0)) * 1000;
    const job = await waitForJob(jobId, waitMs);

    if (job?.status === 'done') {
      const found = readReport(idForReuse);
      return {
        status: 'done', job_id: jobId, meeting_id: idForReuse,
        report_path: job.reportPath, zone: job.zone,
        ...(found ? reportDigest(found.report) : {}),
      };
    }
    if (job?.status === 'failed') {
      return {
        status: 'failed', job_id: jobId, error: clean(job.error),
        hint: '逐字稿不合格或分析失败。逐字稿必须是成员原始发言（每行「姓名 MM:SS 内容」），'
          + 'AI 摘要/会议纪要不能替代。',
      };
    }
    return {
      status: 'running', job_id: jobId, meeting_id: idForReuse,
      hint: `分析在后台继续跑（通常 60~120 秒），不会因等待超时而丢失。`
        + `请稍后用 teaming_job_status 查 job_id=${jobId}。`,
    };
  }

  if (name === 'teaming_push_report') {
    const found = readReport(args.meeting_id);
    if (!found) {
      return {
        ok: false,
        hint: '这场会议还没有分析报告。请先用 teaming_analyze_meeting 生成。',
      };
    }
    let chatId = args.chat_id || null;
    if (!chatId) {
      chatId = findSelfChatId();
      if (!chatId) {
        return {
          ok: false,
          hint: '找不到和你自己的单聊会话。请显式传 chat_id，'
            + '或先在飞书里给自己发一条消息后重试。',
        };
      }
    }
    // 报告文件名约定为 <会议标题>-<meetingId>.report.json，从中还原标题
    const meetingTitle = /^(.+)-\d+\.report\.json$/.exec(found.path.split('/').pop())?.[1] || undefined;
    const r = await pushReport(found.report, {
      chatId, meetingTitle, reportPath: found.path,
    });
    return {
      ok: true,
      meeting_id: args.meeting_id,
      chat_id: chatId,
      message_id: r.messageId,
      report_url: r.reportUrl,
      report_url_source: r.reportUrlSource,
      hint: r.reportUrlSource === 'server'
        ? '已作为交互卡片推送，按钮指向服务器报告页（含图表）。'
        : '已作为交互卡片推送。注意：按钮指向飞书文档兜底页（服务器报告页不可用），图表无法呈现。',
    };
  }

  if (name === 'teaming_report_card') {
    const found = readReport(args.meeting_id);
    if (!found) {
      return {
        ok: false,
        hint: '这场会议还没有分析报告。请先用 teaming_analyze_transcript 或 teaming_analyze_meeting 生成。',
      };
    }
    const meetingTitle = /^(.+)-\d+\.report\.json$/.exec(found.path.split('/').pop())?.[1] || undefined;
    const built = await buildReportCard(found.report, {
      meetingTitle, reportUrl: args.report_url, reportPath: found.path,
    });
    return {
      ok: true,
      meeting_id: args.meeting_id,
      meeting_title: meetingTitle,
      report_url: built.reportUrl,
      report_url_source: built.reportUrlSource,
      card: built.card,
      how_to_send: 'msg_type=interactive，content=JSON.stringify(card)。原样发送，'
        + '不要改动 card 的结构与文案。',
      hint: '★ 用【你自己的】飞书发消息能力把 card 发出去，不要自己设计卡片样式。'
        + (built.reportUrlSource === 'server'
          ? ' 按钮指向服务器报告页（含图表）。'
          : ' 注意：按钮指向飞书文档兜底页（服务器报告页不可用），图表无法呈现。'),
    };
  }

  if (name === 'teaming_job_status') {
    const j = readJob(args.job_id);
    if (!j) return { found: false, hint: `没有这个 job_id：${args.job_id}` };
    if (j.status === 'done') {
      const found = readReport(j.meetingId);
      return { found: true, ...j, ...(found ? reportDigest(found.report) : {}) };
    }
    return { found: true, ...j };
  }

  throw new Error(`未知工具：${name}`);
}

const send = (msg) => realWrite(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  // 只记方法名与工具名，不记参数正文（可能含会议原文）
  trace('request', { method, tool: method === 'tools/call' ? params?.name : undefined, isNotification });
  const startedAt = Date.now();
  try {
    if (method === 'initialize') {
      const want = params?.protocolVersion;
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED.includes(want) ? want : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (method === 'tools/call') {
      try {
        const result = await callTool(params?.name, params?.arguments || {});
        trace('tool_ok', { tool: params?.name, elapsedMs: Date.now() - startedAt });
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        });
      } catch (e) {
        trace('tool_failed', { tool: params?.name, elapsedMs: Date.now() - startedAt, message: String(e?.message || e).slice(0, 200) });
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: clean(e?.message || e) }], isError: true },
        });
      }
      return;
    }
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32603, message: clean(e?.message || e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  trace('stdin_chunk', { bytes: Buffer.byteLength(chunk) });
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch {
      // 解析失败是最容易导致"宿主说连不上"的原因，必须留痕
      trace('stdin_parse_failed', { preview: line.slice(0, 120) });
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => trace('stdin_closed'));
process.stdin.on('error', (e) => trace('stdin_error', { message: String(e?.message || e) }));

