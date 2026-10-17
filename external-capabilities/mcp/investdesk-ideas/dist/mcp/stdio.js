#!/usr/bin/env node
/** MCP stdio 入口：按行读取 JSON-RPC，逐条响应。 */
import { assertConfigured } from '../config.js';
import { TOOL_DEFINITIONS, callTool } from './tools.js';
const SERVER_INFO = { name: 'investdesk-ideas', version: '0.1.0' };
function send(payload) {
    process.stdout.write(JSON.stringify(payload) + '\n');
}
function handle(message) {
    const { id, method, params } = message;
    if (method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
            },
        };
    }
    if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } };
    }
    if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/call') {
        return (async () => {
            try {
                assertConfigured();
                const result = await callTool(params?.name ?? '', params?.arguments ?? {});
                return { jsonrpc: '2.0', id, result };
            }
            catch (error) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { content: [{ type: 'text', text: `配置错误：${error.message}` }], isError: true },
                };
            }
        })();
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } };
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line)
            continue;
        try {
            const message = JSON.parse(line);
            if (message.id === undefined)
                continue; // 通知，不响应
            Promise.resolve(handle(message)).then(send).catch((error) => {
                send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } });
            });
        }
        catch {
            send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } });
        }
    }
});
