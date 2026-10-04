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

import { readFileSync } from 'node:fs';

import { analysisReadiness } from './analysis.mjs';
import { searchMeetings } from './lark.mjs';
import { reportDigest } from './render.mjs';
import { analyzeMeeting, readReport } from './pipeline.mjs';

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
      + '注意：单次分析通常 60~120 秒，可能超过宿主的工具调用超时；'
      + '若返回超时，请按 fallback_command 在终端执行。',
    inputSchema: {
      type: 'object',
      properties: { meeting_id: { type: 'string', description: '会议 ID' } },
      required: ['meeting_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

const clean = (s, max = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function callTool(name, args) {
  if (name === 'teaming_doctor') {
    const ready = analysisReadiness();
    return {
      engine_ready: ready.ready,
      engine_path: ready.enginePath,
      problems: ready.problems,
      hint: ready.ready ? '环境就绪。' : '按 problems 里的「下一步」处理后重试。',
    };
  }

  if (name === 'teaming_list_meetings') {
    const list = searchMeetings({ days: args.days || 30, query: args.query || '' });
    return {
      count: list.length,
      meetings: list.map((m) => ({
        meeting_id: m.meetingId,
        title: m.title,
        has_recording: m.hasRecording,
        has_ai_notes: m.hasDoc,
        analyzable: m.hasRecording || m.hasDoc,
      })),
      hint: 'analyzable=false 的会议没有逐字稿，无法做团队动力分析。',
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
    try {
      const r = await analyzeMeeting(args.meeting_id);
      return {
        ok: true,
        meeting_id: r.meetingId,
        topic: r.topic,
        report_path: r.reportPath,
        transcript_path: r.transcriptPath,
        ...reportDigest(r.report),
        hint: '报告已落盘。需要在消息里呈现时，先读 report_path 再取舍，不要把全文塞回上下文。',
      };
    } catch (e) {
      return {
        ok: false,
        error: clean(e.message),
        fallback_command: `node ${process.argv[1]} --cli-analyze ${args.meeting_id}`,
        hint: e.kind === 'transcript_too_short' || e.kind === 'no_transcript'
          ? '这场会议缺少可用的逐字稿，换一场有逐字稿的会议。'
          : '若为工具调用超时，请在终端用 CLI 执行同一分析（终端没有工具超时限制）。',
      };
    }
  }

  throw new Error(`未知工具：${name}`);
}

const send = (msg) => realWrite(`${JSON.stringify(msg)}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
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
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
