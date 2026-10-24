# 用 CDP 接管豆包工作

> 环境：macOS / DoubaoWork.app 2.33.5（Chromium 147 内核）/ 辅助功能未授权
> 实测日期：2026-10-24
> 验证方式：`/json/version` 返回浏览器版本；`/json` 列出页面 target；DOM 断言读到侧栏入口与输入框；截图复核
> 结论：已验证 —— 能稳定接管并读写界面，全程不需要辅助功能权限

## 权限前提

| 权限 | 本机状态 | 影响 |
|---|---|---|
| 辅助功能 | **未授权**（System Events 报 `-10004`） | AppleScript 模拟键鼠全部失效 |
| 屏幕录制 | 可用 | `screencapture` 能截窗口，仅作辅助证据 |
| 应用自身数据目录可写 | 必须 | 进程要写 profile 锁文件；写不了会打印 `SingletonLock` 并**自保护退出** |

结论：**不依赖辅助功能**。把驱动方式换成 CDP，才绕过这一条。

## 操作手段

1. 正常退出应用（硬杀会丢未保存状态，能用退出就用退出）。
2. 直接执行 App 主二进制，附加 `--remote-debugging-port=<空闲端口>`。
3. 用 CDP 连：`/json/version` 确认通道，`/json` 拿到页面 target，再对目标页执行 `Runtime.evaluate` / `Input.*` / `Page.captureScreenshot`。

为什么选 CDP 而不是截图点击：

- 辅助功能不可用，CGEvent / AppleScript 这条路本来就断了；
- DOM 级读取比截图判读可靠，能拿到"入口在不在""输入框在不在""图片几张"这类可断言的事实；
- 同一个连接既能读又能写，不用在截图与点击之间对齐坐标。

## 如何验证

| 断言 | 期望 |
|---|---|
| `/json/version` | 返回浏览器版本字符串 |
| `/json` | 主界面 target 是内部页面 `doubaowork://doubaowork-chat/chat` |
| DOM：侧栏入口 | 能读到「插件 · 技能 · 伙伴」 |
| DOM：输入框 | 能定位到可编辑区域（ProseMirror） |
| 截图 | 与 DOM 断言一致 |

读和写都验过：点击导航项会真的换页（URL 变成对应的子路由），输入文本会真的出现在输入框里。

## 回退

- 结束带调试参数的进程，`open -a DoubaoWork` 正常启动；调试参数只对那一次进程有效，不会留在配置里。
- 操作过程中产生的对话 / 设置改动，按 App 内正常方式删掉。
- 不要为了省事去改它的 profile 数据文件；一旦需要，先备份再动。

## 何时别用

- **只想读页面内容**：走 `web_fetch` 或官方 API，开 CDP 是杀鸡用牛刀。
- **目标 App 有官方 CLI / API**：优先它们，驱动界面是最后手段。
- **生产账号或他人机器**：CDP 能看到真实会话数据，不要在非本人环境上做。
- **只需要点一下**：先看有没有快捷键或可改的配置文件，改文件比驱动界面便宜。

## 已知坑

- **端口冲突**：`9222` 常被本机 Chrome 的调试端口占用。换一个空闲端口即可，别误判成"App 不支持调试"。
- **启动失败先读日志**：profile 锁文件写不了时应用会静默退出，日志里是 `ProcessSingleton` / `SingletonLock` 字样，而不是明显的权限报错。
- **权限模型要分开看**：辅助功能被拒 ≠ 不能自动化。先确认目标是不是 Chromium/Electron 内核，再决定路线。
- **调试参数是一次性的**：它不写进任何配置，重启即失效，所以每次接管都要重新带参启动。

## 可复现步骤

前置：运行环境必须能写目标 App 自己的数据目录，否则第 3 步会失败。

1. **确认内核是不是 Chromium**。看 App 的进程与框架目录里有没有带版本号的 Chromium 框架
   （实测为 147）。观察：能找到一个 `*Browser Framework.framework/Versions/<版本>` 目录。
   不是 Chromium 就别往下走，CDP 不适用。
2. **正常退出 App**。用系统退出，不要硬杀——硬杀可能丢未保存状态。
3. **带调试端口启动**，端口选一个没被占的：

   ```bash
   "/Applications/<App>.app/Contents/MacOS/<App>" --remote-debugging-port=9333 &
   ```

   观察：`curl -s http://127.0.0.1:9333/json/version` 返回浏览器版本字符串。
4. **列出页面 target**，挑 `type == "page"` 且不是 devtools 的那个：

   ```bash
   curl -s http://127.0.0.1:9333/json | python3 -c "import json,sys;[print(t['type'],t['url']) for t in json.load(sys.stdin)]"
   ```

   观察：主界面 URL 形如 `doubaowork://doubaowork-chat/chat`。
5. **接上 WebSocket 驱动**。Node 内置 `WebSocket` 就够，不需要装包。常用四个方法：
   `Runtime.evaluate`（读 DOM / 执行脚本）、`Input.dispatchMouseEvent`（点击）、
   `Input.insertText`（输入）、`Page.captureScreenshot`（截图）。
6. **优先用 DOM 找元素点击，不要算坐标**：

   ```js
   [...document.querySelectorAll('*')]
     .filter(e => (e.innerText || '').trim() === '<菜单项文本>')
     .pop()
     .click()
   ```

   观察：`location.href` 变化或页面文本出现新内容。
7. **收尾**：结束带参进程，`open -a <App>` 正常启动。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 进程起来立刻消失，日志有 `SingletonLock` / `ProcessSingleton` | 运行环境写不了 App 的数据目录 | 用有权限的方式启动；不要在文件受限的沙箱里拉起图形界面 |
| 端口连不上，但 App 明明在运行 | 端口被占用（`9222` 常被本机 Chrome 的调试端口占着） | 换一个空闲端口，不是 App 不支持调试 |
| 报 `System Events ... -10004` | 辅助功能未授权 | 不要走 AppleScript / CGEvent，改 CDP |
| 重启后调试失效 | 调试参数只对那一次进程有效 | 每次接管都重新带参启动 |
| 点击没反应 | 点到了坐标但对不上元素 | 改成 DOM 定位 + `.click()` |
