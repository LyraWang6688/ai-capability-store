# 给豆包工作接一个自定义 MCP 连接器

> 环境：macOS / DoubaoWork.app 2.33.5 / 自建最小 MCP 服务（本机 HTTP）
> 实测日期：2026-10-24
> 验证方式：连接器装上并显示已安装；服务端日志收到 `server/discover` → `initialize` → `notifications/initialized` → `tools/list`；对话里工具被真实调用（`tools/call`）
> 结论：已验证 —— 本机 HTTP 的 MCP 能被接上并调用；表单明确写了「自定义连接器仅支持在本地电脑中使用」

## 权限前提

| 前提 | 说明 |
|---|---|
| 能修改 App 内的插件设置 | 无需系统权限，但要在 App 里登录账号 |
| 本机端口可被 App 访问 | 连接器只在**本机**生效，不需要公网可达 |
| 服务端实现最小 MCP | 至少支持 `initialize` / `tools/list` / `tools/call` |

不需要辅助功能、不需要屏幕录制、不需要管理员权限。

## 操作手段

1. 侧栏进入「插件 · 技能 · 伙伴」。
2. 右上角「+」→「新建自定义连接器」。
3. 填：服务器名称（自定义）、传输类型 `HTTP`、服务器 URL（服务端的 MCP 端点）。
4. 保存，等它自动握手；列表里出现「连接器已安装」即成功。
5. 新开一个对话，直接要求它调用该工具即可。

注意：这一步只是"装上"。**是否被启用**决定它会不会真的被加载，装完留意界面上的启用按钮。

## 如何验证

**看服务端日志**，这是最硬的证据：

```text
server/discover
initialize
notifications/initialized
tools/list
tools/call
```

出现 `tools/call` 说明 App 不只是连上了，而是真的把工具调用打过来了。

**看 App 内**：

- 连接器列表里能看到它，并且详情弹窗里列出了「包含的操作」（即它从 `tools/list` 拿到的工具）。
- 对话里回复会出现工具调用记录。

## 回退

- 删连接器：「插件 · 技能 · 伙伴 → 连接器 → 个人」→ 打开该连接器 → 详情弹窗底部「…」→ 删除。
- 删测试对话：会话列表里删除即可。
- 停掉本机服务后连接器会失效，但条目还在，需要手动删。

## 何时别用

- **要让它访问公网服务**：先确认该 App 的连接器是否支持远程地址；本机实测的表单文案写的是「仅支持在本地电脑中使用」。需要跨设备时改用别的宿主。
- **只是想给它喂数据**：直接对话里贴内容或上传文件更省事，不必为了一个工具就起 MCP。
- **工具要返回图片**：不要走 MCP——它不会渲染，见 [image-rendering.md](./image-rendering.md)。

## 已知坑

- **「装上了」≠「用得上」**：安装只写依赖，启用是另一步；装完不启用，对话里根本看不到这个工具。
- **连接器是本机的**：表单原文「自定义连接器仅支持在本地电脑中使用」，所以别指望在另一台设备上看到它。
- **模型会夸大**：调用成功了它可能顺带说"图片已经显示出来了"，但实际没有。判断结果以服务端日志 + 界面事实为准。

## 可复现步骤

1. **写一个最小 MCP server**。Node 标准库就够：只处理 `POST /mcp`，按 JSON-RPC 回三件事——
   `initialize`（回 `protocolVersion`，最稳的是回显客户端请求的那个值、`capabilities.tools`、
   `serverInfo`）、`tools/list`（回工具清单）、`tools/call`（回 `content` 数组）。
   `notifications/*` 回 `202` 空响应。
2. **起服务**。观察：日志打印监听地址。
3. **先用 curl 自测，别急着挂 App**：

   ```bash
   curl -s -X POST http://127.0.0.1:<port>/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```

   再依次打 `tools/list`、`tools/call`，三个都通了再去接 App。
4. **打开连接器表单**：CDP 点侧栏「插件 · 技能 · 伙伴」→ 右上「+」→「新建自定义连接器」。
5. **填表单**。要点：这套界面是 React，**直接改 `el.value` 不生效**，必须用原生 setter + 事件：

   ```js
   const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
   setter.call(el, 'http://127.0.0.1:<port>/mcp');
   el.dispatchEvent(new Event('input', { bubbles: true }));
   ```

6. **保存**。观察两处：界面出现「连接器已安装」；**服务端日志**出现 `initialize` → `tools/list`。
7. **新开对话让它调用该工具**。观察：服务端日志出现 `tools/call`（这一步才算真的接上了）。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 表单填了但保存后是空的 | 直接赋值没触发框架的受控组件更新 | 用原生 setter + `dispatchEvent(new Event('input'))` |
| 装上了，但对话里根本看不到这个工具 | 安装只写依赖，**启用是另一步** | 补启用，再重启宿主 |
| 模型说"已成功调用并显示"，但界面什么都没有 | 模型自述不可信 | 以服务端日志 + DOM 断言为准 |
| 想在另一台设备上用同一个连接器 | 这个 App 的自定义连接器**只在本机生效** | 换宿主，或改成本机内使用 |
