# 用 CDP 接管豆包工作

> 环境：macOS / DoubaoWork.app 2.33.5（Chromium 147 内核）/ 辅助功能未授权
> 实测日期：2026-10-24
> 验证方式：`/json/version` 返回浏览器版本；`/json` 列出页面 target；DOM 断言读到侧栏入口与输入框；截图复核
> 结论：已验证 —— 能稳定接管并读写界面，全程不需要辅助功能权限

## 权限前提

| 权限 | 本机状态 | 缺了会怎样 |
|---|---|---|
| 辅助功能 | **未授权**（`-10004`） | AppleScript / CGEvent 全废；本方案不依赖它 |
| 屏幕录制 | 可用 | 仅影响截图兜底证据 |
| 应用自身数据目录可写 | 必须 | 启动时打印 `SingletonLock` 并**自保护退出** |

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| App 主二进制 + `--remote-debugging-port` | 系统命令 | 带调试端口启动，打开 CDP 通道 | 能写 App 数据目录 |
| `curl` | CLI | 读 `/json/version`、`/json` | 端口可连 |
| Node 内置 `WebSocket` | 运行时能力 | 直接说 CDP，不装第三方包 | Node 18+ |
| `Runtime.evaluate` | CDP 方法 | 读 DOM、执行脚本、点元素 | 已连上目标页 |
| `Input.dispatchMouseEvent` / `Input.insertText` | CDP 方法 | 点击 / 输入 | 已连上目标页 |
| `Page.captureScreenshot` | CDP 方法 | 截图留证 | 已连上目标页 |
| `screencapture` | 系统命令 | 连不上 CDP 时的备用证据 | 屏幕录制权限 |
| `open -a` | 系统命令 | 结束后恢复正常启动 | — |

## 可复现步骤

1. **确认内核**：看 App 的框架目录里有没有带版本号的 Chromium 框架（实测 147）。
   *观察*：能找到 `*Browser Framework.framework/Versions/<版本>`。不是 Chromium 就停，CDP 不适用。
2. **正常退出 App**。用系统退出，不要硬杀。
3. **带调试端口启动**，避开 `9222`：

   ```bash
   "/Applications/<App>.app/Contents/MacOS/<App>" --remote-debugging-port=9333 &
   ```

   *观察*：`curl -s http://127.0.0.1:9333/json/version` 返回浏览器版本。
4. **列出页面 target**，挑 `type == "page"`：

   ```bash
   curl -s http://127.0.0.1:9333/json | python3 -c "import json,sys;[print(t['type'],t['url']) for t in json.load(sys.stdin)]"
   ```

   *观察*：主界面 URL 形如 `doubaowork://doubaowork-chat/chat`。
5. **接上 WebSocket 驱动**，之后就能用上表的 CDP 方法读写界面。
6. **按 DOM 文本定位并点击，不算坐标**：

   ```js
   [...document.querySelectorAll('*')]
     .filter(e => (e.innerText || '').trim() === '<菜单项文本>').pop().click()
   ```

   *观察*：`location.href` 变化，或页面出现新文本。
7. **收尾**：结束带参进程，`open -a <App>` 正常启动。
   *观察*：进程不再带 `--remote-debugging-port`，界面恢复。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 进程起来立刻消失，日志有 `SingletonLock` / `ProcessSingleton` | 运行环境写不了 App 数据目录 | 用有权限的方式启动；别在文件受限的沙箱里拉起 GUI |
| 端口连不上，但 App 在运行 | 端口被占（`9222` 常被 Chrome 调试端口占着） | 换空闲端口，不是 App 不支持调试 |
| 报 `System Events ... -10004` | 辅助功能未授权 | 不走 AppleScript，改 CDP |
| 重启后调试失效 | 参数只对那一次进程有效 | 每次接管都重新带参启动 |
| 点击没反应 | 坐标对不上元素 | 改成 DOM 定位 + `.click()` |

## 何时别用

- **只想读页面内容**：走 `web_fetch` 或官方 API，开 CDP 是杀鸡用牛刀。
- **目标 App 有官方 CLI / API**：优先它们，驱动界面是最后手段。
- **生产账号或他人机器**：CDP 能看到真实会话数据，不要在非本人环境上做。
- **只需要点一下**：先看有没有快捷键或可改的配置文件。
