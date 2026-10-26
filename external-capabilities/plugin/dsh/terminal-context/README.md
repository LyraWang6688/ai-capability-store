# @lyra_wang/dsh-terminal-context

把 **DSH 侧边栏终端**当前屏幕的内容交给 Agent，让它下一步的指令依据你真实的终端状态，
而不是凭空安排。

## 它解决什么

你在侧边栏终端里跑命令时，Agent 看不到你敲了什么、看到了什么报错、在哪个目录。
于是它给的指令经常"对着空气"：让你 `cd` 到已经在的目录、重复你已经做过的步骤、
或者在你已经失败的前提下继续往下走。

装上之后，Agent 能读到当前屏幕，于是：

- 知道你**在哪个目录**（不用你说）
- 知道你**上一条命令的结果**（成功/报错）
- 你跑完之后，它能**接着结果往下做**

## 怎么工作

```
界面侧（同一页面）               Host 侧
读 .xterm-rows 渲染出的可见行  →  POST /plugins/terminal-context/push  →  内存缓存
                                                                       ↓
                                                          Agent 工具 read_terminal_context
```

**只读**：不改终端、不发输入、不落盘（终端里可能有 token，进程结束就没了）。

## 不覆盖：右侧「浏览器 tab」（结构上做不到）

**本插件只读侧边栏终端，不读右侧浏览器 tab。** 这不是没做，是这条路从根上不成立。

浏览器 tab 由官方包 `@deepseek-ai/dsh-client-ui-sidebar-browser` 渲染，它的 README 写明：

> Web 使用 **iframe** 和应用维护的 history；Desktop 使用 **Electron `<webview>`**……
> 本包**不会向被访问内容注入 Electron 或 Node 能力**。

所以它和终端是两种东西：

| 面板 | 结构 | 父页面能读 DOM / 收选中吗 |
|---|---|---|
| 侧边栏终端 | 同一 document 里的 xterm DOM（`.xterm-rows`） | ✅ 能 |
| 浏览器 tab | iframe（Web）/ `<webview>`（Desktop），**独立浏览上下文** | ❌ 进不去，也收不到 `selectionchange` |

**实测（0.4.0 诊断，2026-10-26）**：全页面按 `sidebar / rightbar / panel / terminal / browser`
扫容器，只命中 1 个 `PIRFFq_sidebarCol`（左栏会话列表：「新会话 / 插件 / 自动化任务 / 工作区 /
workplace…」），浏览器 tab 正文 **0 命中**。桌面版和 Web 版都一样，因为两者都不是同一 document。

想拿浏览器里的内容，只有这三条路（代价递增）：

1. **只拿 URL + 标题**（面板自己保留），正文由 Agent 按需抓（公开页 `web_fetch`，需登录态用浏览器 MCP）
2. **自建同源代理**：Host 路由把页面取回来再渲染，同源才有机会读 DOM；要处理相对链接、CSP、登录态
3. **在用户自己的浏览器里装扩展/userscript**，把选中内容主动推给 Host 路由

> 结论：不要在 `querySelectorAll` 里加 `[class*="browser"]` 之类的选择器试图修——那修不好。

## 已知限制

- **只能读到当前可见的一屏**（最多 60 行）。向上滚出屏幕的缓冲读不到 —— 这是"看屏幕"这条路的固有代价。
- 依赖 xterm 的 DOM 类名（`.xterm-rows`）。xterm 大改版会失效，失效表现是"没数据"，不会影响 DSH 启动。
- 内容**变了才推**，每 2 秒检查一次。

## 安全设计

`inject: []` —— 界面插件不声明任何服务依赖。这是刻意的：DSH 的界面插件如果声明了一个
不存在的服务，入口会永久 pending，**导致整个界面起不来**（v0.1.0 踩过这个坑）。
不声明依赖，最坏情况是"插件没反应"，不会拖垮应用。

## 要求

- DSH 桌面端
- 侧边栏打开过终端

## 许可

MIT
