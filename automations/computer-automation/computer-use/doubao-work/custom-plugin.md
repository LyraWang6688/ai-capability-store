# 在豆包工作里自定义插件（连接器与技能）

> 环境：macOS / DoubaoWork.app 2.33.5（Chromium 147 内核）/ 辅助功能未授权 / 已登录账号
> 实测日期：2026-10-24
> 验证方式：CDP 读 `/json/version` 与页面 target + DOM 断言（菜单项、分类计数、`img.naturalWidth`）+ 自建 MCP 服务端日志 + 截图
> 结论：已验证 —— 连接器能接本机 MCP 并调用；技能入口与三条来源已确认（上传格式未实测）；工具返回的图片**不渲染**

## 权限前提

| 权限 | 本机状态 | 缺了会怎样 |
|---|---|---|
| 辅助功能 | **未授权**（`-10004`） | AppleScript / CGEvent 全废；本方案改用 CDP，不依赖它 |
| 屏幕录制 | 可用 | 仅影响截图兜底证据 |
| 应用自身数据目录可写 | 必须 | 带调试端口启动时打印 `SingletonLock` 并**自保护退出** |
| 已登录 App 账号 | 必须 | 插件 / 技能 / 连接器列表都跟账号走 |

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| App 主二进制 + `--remote-debugging-port` | 系统命令 | 打开 CDP 通道（避开 `9222`） | 能写 App 数据目录 |
| `curl` | CLI | 读 `/json/version`、`/json`；也用来先自测 MCP 服务 | 端口可连 |
| Node 内置 `WebSocket` | 运行时能力 | 直接说 CDP，不装第三方包 | Node 18+ |
| `Runtime.evaluate` | CDP 方法 | 读 DOM、点元素、填表单 | 已连上目标页 |
| `Input.dispatchMouseEvent` / `Input.insertText` | CDP 方法 | 点击 / 输入 | 已连上目标页 |
| `Page.captureScreenshot` | CDP 方法 | 截图留证 | 已连上目标页 |
| Node 标准库 `http` | 运行时能力 | 起最小 MCP server（JSON-RPC over POST） | Node 18+ |
| 原生 value setter + `dispatchEvent('input')` | 浏览器 API | 让 React 受控组件接受写入 | — |
| 服务端日志 | 观测手段 | 判断握手与工具调用是否真的发生 | 服务端打日志 |
| 公网 HTTPS 图床 | 外部资源 | 对照"图片能显示"这一组 | 图片可公开访问 |

## 可复现步骤

### A. 先能控制界面（后面两步都依赖它）

1. **确认内核**：看 App 框架目录有没有带版本号的 Chromium 框架（实测 147）。
   *观察*：能找到 `*Browser Framework.framework/Versions/<版本>`；不是 Chromium 就停。
2. **正常退出 App**（别硬杀），再带调试端口启动，避开 `9222`：

   ```bash
   "/Applications/<App>.app/Contents/MacOS/<App>" --remote-debugging-port=9333 &
   ```

   *观察*：`curl -s http://127.0.0.1:9333/json/version` 返回浏览器版本。
3. **列出页面 target**，挑 `type == "page"`：

   ```bash
   curl -s http://127.0.0.1:9333/json | python3 -c "import json,sys;[print(t['type'],t['url']) for t in json.load(sys.stdin)]"
   ```

   *观察*：主界面 URL 形如 `doubaowork://doubaowork-chat/chat`。
4. **接上 WebSocket 驱动**，之后用上表的 CDP 方法读写。点击一律按 DOM 文本定位，不算坐标：

   ```js
   [...document.querySelectorAll('*')]
     .filter(e => (e.innerText || '').trim() === '<菜单项文本>').pop().click()
   ```

   *观察*：`location.href` 变化，或页面出现新文本。

### B. 自定义连接器（接一个 MCP 服务）

1. **写最小 MCP server**：只处理 `POST /mcp`，回 `initialize`（回显客户端 `protocolVersion` +
   `capabilities.tools` + `serverInfo`）、`tools/list`、`tools/call`；`notifications/*` 回 `202`。
2. **先用 curl 自测**，三个方法都通过再挂 App：

   ```bash
   curl -s -X POST http://127.0.0.1:<port>/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```

3. **新建连接器**：点侧栏「插件 · 技能 · 伙伴」→ 右上「+」→「新建自定义连接器」。
   *观察*：弹出表单，含服务器名称 / 传输类型（`HTTP`）/ 服务器 URL / 自定义 Headers。
4. **填表单**（React 受控组件，直接改 `value` 不生效）：

   ```js
   const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
   setter.call(el, 'http://127.0.0.1:<port>/mcp');
   el.dispatchEvent(new Event('input', { bubbles: true }));
   ```

5. **保存**。*观察*两处：界面出现「连接器已安装」；**服务端日志**出现
   `initialize` → `notifications/initialized` → `tools/list`。
6. **新开对话让它调用工具**。*观察*：服务端日志出现 `tools/call`——这步才算真的接上。

> 表单原文写明「自定义连接器仅支持在本地电脑中使用」，所以本机地址就够，不需要公网服务器。

### C. 自定义技能

1. 点「+」，读菜单项文本。*观察*：四项——与豆包对话新建技能 / **上传技能** / 新建自定义连接器 / 前往企业管理后台。
2. 点顶部筛选图标，读分类计数。*观察*：插件 14 / 技能 179 / 连接器 16。

> 结论：技能**不是只能对话创建**，菜单里有「上传技能」。上传格式与生效链路见下方「还没验证的区域」。

### D. 图片能不能显示（连接器能力的边界）

1. 让工具返回 `content: [{type:'text'}, {type:'image', data:<base64>, mimeType:'image/png'}]`，
   触发调用后立刻断言：

   ```js
   [...document.querySelectorAll('img')]
     .map(i => ({ w: i.naturalWidth, src: (i.currentSrc || i.src).slice(0, 60) }))
     .filter(x => x.w > 40)
   ```

   *观察*：返回**空数组**——工具调用了，但图片没渲染。
2. 对照 A：在对话里要求原样输出 `![t](https://<公网域名>/<路径>.png)`，再断言。
   *观察*：出现 `w > 0` 的真实图片。
3. 对照 B：换成 `http://127.0.0.1:<port>/x.png`。*观察*：元素存在但 `naturalWidth === 0`（占位图）。

**结论：这个 App 只认公网 HTTPS 的 Markdown 图片；MCP 工具返回图片内容不显示。**

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 进程起来立刻消失，日志有 `SingletonLock` / `ProcessSingleton` | 运行环境写不了 App 数据目录 | 用有权限的方式启动；别在文件受限的沙箱里拉起 GUI |
| 端口连不上，但 App 在运行 | 端口被占（`9222` 常被 Chrome 调试端口占着） | 换空闲端口，不是 App 不支持调试 |
| 报 `System Events ... -10004` | 辅助功能未授权 | 不走 AppleScript，改 CDP |
| 重启后调试失效 | 调试参数只对那一次进程有效 | 每次接管都重新带参启动 |
| 点击没反应 | 坐标对不上元素 | 改成 DOM 定位 + `.click()` |
| 表单填了但保存后是空的 | 直接赋值没触发受控组件更新 | 原生 setter + `dispatchEvent(new Event('input'))` |
| 装上了，对话里看不到这个工具 | 安装只写依赖，**启用是另一步** | 补启用，再重启宿主 |
| 模型说"已成功调用并显示"，界面什么都没有 | 模型自述不可信 | 以服务端日志 + DOM 断言为准 |
| `<img>` 列表里出现 `data:image/svg+xml` 条目 | 加载失败后的占位图 | 换成公网 HTTPS 地址 |
| 元素看起来有宽高，但没有图 | 占位图也占位，`naturalWidth` 才是判据 | 用 `naturalWidth` 判定，别看 CSS 尺寸 |
| 以为技能只能对话创建 | 只读发布说明的措辞，没看菜单 | 以界面菜单实测为准，别拿介绍当能力清单 |
| 按文本找不到菜单项 | 元素是 `div`/`span`，没有 `aria-label` | 遍历所有元素按 `innerText` 精确匹配，取最后一个命中 |

## 何时别用

- **只想读页面内容**：走 `web_fetch` 或官方 API，开 CDP 是杀鸡用牛刀。
- **想让它调用公网服务**：先确认连接器是否支持远程地址；本机实测表单写明「仅支持在本地电脑中使用」。
- **想让它内联显示图**：别走 MCP 返回图片内容，直接给公网 HTTPS 图片地址；没有图床就别在这个 App 里做图表交付。
- **要跨宿主复用同一套能力**：技能与连接器都是账号 / 本机内的，换宿主带不走。

### 还没验证的区域（别依赖它）

| 缺口 | 为什么不能假设 |
|---|---|
| 上传技能的**文件格式** | 不知道要不要压缩包、能不能直接吃通用 `SKILL.md` |
| 上传后的**生效链路** | 不能承诺"传完就能用"，可能需要重启或管理员审核 |
| 技能的**版本与更新**机制 | 不确定能否覆盖升级，别按"有版本号"来设计流程 |
| 与**对话新建**的技能是否同一种对象 | 两者差异未知，别混着管理 |
