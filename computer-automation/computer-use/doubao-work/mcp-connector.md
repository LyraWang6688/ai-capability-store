# 给豆包工作接一个自定义 MCP 连接器

> 环境：macOS / DoubaoWork.app 2.33.5 / 自建最小 MCP 服务（本机 HTTP）
> 实测日期：2026-10-24
> 验证方式：界面显示「连接器已安装」+ 服务端日志收到 `initialize` / `tools/list` / `tools/call`
> 结论：已验证 —— 本机 HTTP 的 MCP 能接上并调用；表单原文写明「自定义连接器仅支持在本地电脑中使用」

## 权限前提

| 前提 | 说明 |
|---|---|
| 能改 App 内插件设置（需登录） | 无系统权限要求 |
| 本机端口可被 App 访问 | 连接器**只在本机生效**，不需要公网 |
| 服务端实现最小 MCP | `initialize` / `tools/list` / `tools/call` 三个方法 |

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| Node 标准库 `http` | 运行时能力 | 起最小 MCP server（JSON-RPC over POST） | Node 18+ |
| `curl` | CLI | 挂进 App 前先自测三个方法 | 服务已启动 |
| `Runtime.evaluate` | CDP 方法 | 打开插件页、点「+」、填表单 | 已接管 App，见 [cdp-takeover.md](./cdp-takeover.md) |
| 原生 value setter + `dispatchEvent('input')` | 浏览器 API | 让 React 受控组件接受写入 | — |
| 服务端日志 | 观测手段 | 判断握手与工具调用是否真的发生 | 服务端打日志 |

## 可复现步骤

1. **写最小 MCP server**：只处理 `POST /mcp`，按 JSON-RPC 回三件事 ——
   `initialize`（回 `protocolVersion`，最稳的是回显客户端请求值、`capabilities.tools`、`serverInfo`）、
   `tools/list`、`tools/call`；`notifications/*` 回 `202` 空响应。
   *观察*：启动日志打印监听地址。
2. **先用 curl 自测，别急着挂 App**：

   ```bash
   curl -s -X POST http://127.0.0.1:<port>/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```

   *观察*：三个方法依次返回合法 JSON-RPC（无 `error`）后再往下。
3. **打开连接器表单**：CDP 点侧栏「插件 · 技能 · 伙伴」→ 右上「+」→「新建自定义连接器」。
4. **填表单**。这套界面是 React，直接改 `el.value` 不生效：

   ```js
   const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
   setter.call(el, 'http://127.0.0.1:<port>/mcp');
   el.dispatchEvent(new Event('input', { bubbles: true }));
   ```

   *观察*：输入框里能看到填进去的值。
5. **保存**。*观察*两处：界面出现「连接器已安装」；**服务端日志**出现
   `initialize` → `notifications/initialized` → `tools/list`。
6. **新开对话让它调用该工具**。*观察*：服务端日志出现 `tools/call` —— 这一步才算真的接上。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 表单填了但保存后是空的 | 直接赋值没触发受控组件更新 | 原生 setter + `dispatchEvent(new Event('input'))` |
| 装上了，对话里看不到这个工具 | 安装只写依赖，**启用是另一步** | 补启用，再重启宿主 |
| 模型说"已成功调用并显示"，界面什么都没有 | 模型自述不可信 | 以服务端日志为准 |
| 想换台设备用同一个连接器 | 这类连接器**只在本机生效** | 换宿主，或只在本机内使用 |

## 何时别用

- **要让它访问公网服务**：先确认连接器是否支持远程地址；本机实测的表单文案是「仅支持在本地电脑中使用」。
- **只是想喂数据**：对话里贴内容或上传文件更省事。
- **工具要返回图片**：不要走 MCP —— 它不会渲染，见 [image-rendering.md](./image-rendering.md)。
