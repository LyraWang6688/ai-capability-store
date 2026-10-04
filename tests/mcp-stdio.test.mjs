/**
 * MCP 协议层自测：不联网、不碰真实飞书。
 *
 * 覆盖：
 *  - initialize 握手与协议版本协商
 *  - tools/list 结构与 readOnlyHint
 *  - stdout 绝对纯净（有任何非 JSON 行即失败）
 *  - 未知方法返回标准 JSON-RPC 错误而不是崩溃
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'mcpServer.mjs');

/** 起一个 MCP 子进程，收集 stdout/stderr */
function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { messages: [], polluted: [], stderr: '' };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { state.messages.push(JSON.parse(line)); } catch { state.polluted.push(line); }
    }
  });
  child.stderr.on('data', (d) => { state.stderr += d.toString(); });
  state.send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  state.waitFor = async (id, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = state.messages.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  };
  state.stop = () => child.kill('SIGTERM');
  return state;
}

test('MCP 握手 + 工具清单 + stdout 纯净性', async () => {
  const s = startServer();
  try {
    s.send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const init = await s.waitFor(1);
    assert.ok(init, 'initialize 应有响应');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'teaming');

    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = await s.waitFor(2);
    assert.ok(listed, 'tools/list 应有响应');

    const tools = listed.result.tools;
    assert.ok(tools.length >= 4, `至少 4 个工具，实际 ${tools.length}`);

    const names = tools.map((t) => t.name);
    for (const required of ['teaming_doctor', 'teaming_list_meetings', 'teaming_read_report', 'teaming_analyze_meeting']) {
      assert.ok(names.includes(required), `缺少工具 ${required}`);
    }

    // 生态准入要求：至少一个无副作用工具
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
    assert.ok(readOnly.length >= 3, '只读工具应至少 3 个');

    // 每个工具都要有给模型看的说明
    for (const t of tools) {
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 10, `${t.name} 的 description 太短`);
      assert.equal(t.inputSchema.type, 'object');
    }

    // 未知方法不应崩
    s.send({ jsonrpc: '2.0', id: 3, method: 'no/such/method' });
    const unknown = await s.waitFor(3);
    assert.ok(unknown?.error, '未知方法应返回 JSON-RPC error');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.polluted.length, 0, `stdout 被污染：${s.polluted.slice(0, 3).join(' | ')}`);
  } finally {
    s.stop();
  }
});

test('协议版本不被支持时回落到默认版本', async () => {
  const s = startServer();
  try {
    s.send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const init = await s.waitFor(1);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(s.polluted.length, 0);
  } finally {
    s.stop();
  }
});
