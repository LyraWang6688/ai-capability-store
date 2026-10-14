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
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = process.env.TEAMING_CLI || join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

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
const LOG_PATH = process.env.TEAMING_MCP_LOG
  || join(dirname(fileURLToPath(import.meta.url)), '..', '.state', 'mcp.log');
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
import { readReport, pushReport, listMeetingsWithEligibility } from './pipeline.mjs';
import { newJobId, writeJob, readJob, waitForJob, pruneJobs } from './jobs.mjs';

const SERVER_INFO = { name: 'teaming', version: '0.1.0' };
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
        // 默认值刻意压到 10 秒：前置检查（lark-cli 取数）本身要 ~17 秒，
        // 若再加 45 秒内联等待，总耗时会超过宿主的 tools/call 超时（豆包工作约 60 秒），
        // 宿主会在第 60 秒取消调用——用户看到的就是"失败"，尽管分析其实已经跑完。
        // 2026-10-14 实测：默认 45 秒时总耗时 62 秒，正好被取消。
        wait_seconds: { type: 'integer', minimum: 0, maximum: 600, description: '最多内联等待多少秒，默认 10；填 0 则立即返回 job_id' },
        force: { type: 'boolean', description: '已有报告时是否强制重跑，默认 false' },
      },
      required: ['meeting_id'],
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
      + '推送是幂等的，重复调用不会产生重复消息。',
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

    const waitMs = Math.max(0, Math.min(600, Number.isFinite(args.wait_seconds) ? args.wait_seconds : 10)) * 1000;
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
        trace('tool_ok', { tool: params?.name });
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
        trace('tool_failed', { tool: params?.name, message: String(e?.message || e).slice(0, 200) });
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

