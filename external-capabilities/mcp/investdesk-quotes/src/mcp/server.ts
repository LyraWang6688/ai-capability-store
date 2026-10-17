#!/usr/bin/env node
/**
 * InvestDesk 行情 MCP 服务。
 *
 * 两种传输方式：
 *   node src/mcp/server.ts              # Streamable HTTP，默认 http://127.0.0.1:8787/mcp
 *   node src/mcp/server.ts --stdio      # 标准输入输出，供本地 MCP 客户端直连
 *
 * 零依赖手写实现（JSON-RPC 2.0 + MCP tools 协议），不引入 @modelcontextprotocol/sdk。
 * 在豆包工作里作为「自定义连接器」接入时，传输类型选 HTTP，URL 填 http://127.0.0.1:8787/mcp。
 */

import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

import { MCP_PORT } from '../config.ts';
import { TOOL_DEFINITIONS, callTool } from './tools.ts';

// stdio 模式下 stdout 是纯协议通道，任何 console.log 都会污染 JSON-RPC，
// 表现为宿主「握手失败」但进程还活着，现场极难复现。先把 log 拦到 stderr。
if (process.argv.includes('--stdio')) {
  console.log = (...args: unknown[]) => console.error(...args);
}

const SERVER_NAME = 'investdesk-quotes';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: string | number | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function negotiateVersion(requested: unknown): string {
  const value = typeof requested === 'string' ? requested : '';
  return PROTOCOL_VERSIONS.includes(value) ? value : (PROTOCOL_VERSIONS[0] as string);
}

async function handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id = null, method, params = {} } = message;

  switch (method) {
    case 'initialize':
      return success(id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'InvestDesk 行情与持仓服务。lookup_quotes 查价格，portfolio_overview 看持仓汇总，sync_prices 刷新价格。',
      });

    case 'notifications/initialized':
      return null;

    case 'ping':
      return success(id, {});

    case 'tools/list':
      return success(id, { tools: TOOL_DEFINITIONS });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      const result = await callTool(name, args);
      return success(id, result);
    }

    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

async function dispatch(payload: unknown): Promise<unknown> {
  if (Array.isArray(payload)) {
    const results = await Promise.all(
      payload.map((item) => handleMessage(item as JsonRpcRequest).catch((error: unknown) =>
        failure(
          ((item as JsonRpcRequest).id ?? null),
          -32603,
          error instanceof Error ? error.message : String(error),
        ),
      )),
    );
    return results.filter((r) => r !== null);
  }
  return handleMessage(payload as JsonRpcRequest);
}

function startHttpServer(): void {
  const server = createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.url?.split('?')[0] === '/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (req.url?.split('?')[0] !== MCP_PATH) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', hint: `MCP endpoint is ${MCP_PATH}` }));
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // 本实现不提供服务端推送（SSE），按规范返回 405
      res.writeHead(405, { ...cors, Allow: 'POST' });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, Allow: 'POST' });
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(failure(null, -32700, 'Parse error')));
        return;
      }

      dispatch(payload)
        .then((result) => {
          if (result === null || (Array.isArray(result) && result.length === 0)) {
            res.writeHead(202, cors);
            res.end();
            return;
          }
          // 无状态服务端：不签发 Mcp-Session-Id。规范允许无状态实现，
          // 少一类状态就少一类 bug（参考 teaming-bot 的 /api/mcp 做法）。
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[mcp] 处理失败：', message);
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(failure(null, -32603, message)));
        });
    });
  });

  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.error(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} 已启动: http://127.0.0.1:${MCP_PORT}${MCP_PATH}`);
    console.error('[mcp] 健康检查: http://127.0.0.1:' + MCP_PORT + '/health');
  });

  const shutdown = () => {
    console.error('[mcp] 正在关闭…');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startStdioServer(): void {
  console.error(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} 以 stdio 模式启动`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify(failure(null, -32700, 'Parse error')) + '\n');
      return;
    }
    dispatch(payload)
      .then((result) => {
        if (result === null) return;
        if (Array.isArray(result) && result.length === 0) return;
        process.stdout.write(JSON.stringify(result) + '\n');
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(JSON.stringify(failure(null, -32603, message)) + '\n');
      });
  });
  rl.on('close', () => process.exit(0));
}

if (process.argv.includes('--stdio')) {
  startStdioServer();
} else {
  startHttpServer();
}
