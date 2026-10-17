#!/usr/bin/env node
/**
 * stdio 入口。
 *
 * MCP 的标准用法是宿主 spawn 一个子进程、用 stdin/stdout 通信，
 * 所以 npm bin `investdesk-quotes` 指向这里，默认走 stdio。
 *
 * 需要 HTTP（给豆包工作的「自定义连接器」用）时走另一个 bin：
 *   investdesk-quotes-http   或   node src/mcp/server.ts
 */

process.argv.push('--stdio');
await import('./server.ts');
