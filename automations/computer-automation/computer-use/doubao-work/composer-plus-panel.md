# 豆包工作的「＋」面板（输入框里的加号）

> 环境：macOS 15 / DoubaoWork.app 2.34.1（Chromium 147 内核）/ 辅助功能未授权 / 已登录账号
> 实测日期：2026-10-28
> 验证方式：CDP `Runtime.evaluate` 读 DOM（`[role=listbox]`、`[role=option]`、分组标签、搜索 contenteditable 的 rect）+ `Page.captureScreenshot` 对照
> 结论：已验证 —— 「＋」打开的是**输入框向上延展的面板**：上面是分组列表、搜索框固定在面板最下方；输入关键词后同一块列表变跨类分组结果

## 权限前提

| 权限 | 本机状态 | 缺了会怎样 |
|---|---|---|
| 辅助功能 | **未授权**（`-10004`） | AppleScript 模拟键鼠全废、`tell application … to quit` 也被拒；本方案走 CDP |
| 屏幕录制 | 可用 | 只影响「不接管就截图」这条兜底 |
| 应用数据目录可写 | 必须 | 带调试端口启动时打印 `SingletonLock` 并自保护退出（见踩坑） |
| 已登录 App 账号 | 必须 | 面板里的联系人 / 飞书对话 / 云盘分组都跟账号走，未登录只能看到「添加」那一组 |

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| App 主二进制 + `--remote-debugging-port` | 系统命令 | 打开 CDP 通道（避开 9222） | 能写 App 数据目录；`open --args` 不带参，必须直接起二进制 |
| `curl` | CLI | 读 `/json` 列 target、`/json/version` 确认内核 | 端口可连 |
| Node 内置 `WebSocket` | 运行时能力 | 直接说 CDP，不装第三方包 | Node 18+ |
| `Runtime.evaluate` | CDP 方法 | 读 DOM、点元素、聚焦搜索框 | 已连上目标页 |
| `Input.dispatchMouseEvent` / `Input.insertText` | CDP 方法 | 真实点击（`.click()` 对 React 触发不了弹层）/ 输入中文 | 已连上目标页 |
| `Page.captureScreenshot` | CDP 方法 | 留证 | 已连上目标页 |

## 可复现步骤

1. **接上界面**：`killall -q DoubaoWork` → 直接起二进制
   `/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork --remote-debugging-port=9333`，
   然后 `curl -s http://127.0.0.1:9333/json | grep page`。
   *观察*：target 里有 `type=page`、`url=doubaowork://doubaowork-chat/chat`；`/json/version` 返回 `Chrome/147…`。
2. **点输入框里的「＋」**：先在 DOM 里定位它（底部、约 36×36、无 aria-label），
   再用 `Input.dispatchMouseEvent` 发 `mousePressed` + `mouseReleased`。
   *观察*：出现 `[role=listbox]`，rect 约 545×400，顶部贴住输入框。
3. **读面板结构**：`listbox` 内是 `[role=group]`（每组一个 `[class*=groupLabel]` 吸顶标签）
   + 若干 `[role=option]`（行高 32px）。
   *观察*：分组顺序 `添加`（文件/云盘/共享屏幕/截图提问/技能/插件/目标/计划）→ `联系人` → `飞书对话` → `云盘` → `对话`；
   行内是「图标 + 标签 + 右侧灰色说明」，带 `>` 的行点开是子菜单（共享屏幕和应用 / 技能 / 插件）。
4. **确认搜索框位置**：`[contenteditable=true]` 且 `innerText=搜索...`，rect 在 listbox 下方（约 `y=702`），
   即**面板最底部**，搜索行下面才是输入框自己的工具条。
   *观察*：面板 = 上面滚动列表 + 最底一条搜索行；搜索行没有边框盒子，只有光标和占位文字。
5. **在搜索框里输入**（先 `el.focus()` 再 `Input.insertText`，不要用坐标点，点偏会关掉面板），
   输入一个能同时命中多类的词（实测「邯」）。
   *观察*：列表原地变成跨类分组结果 —— `联系人` / `飞书对话` / `技能` / `云盘` / `对话`，
   每组末尾一行灰色 `查看更多`；标题里命中的字高亮；组标签吸顶。
6. **收尾**：`killall -q DoubaoWork` 后 `open -a DoubaoWork` 正常启动（调试参数只对那一次进程有效）。
   *观察*：`curl 127.0.0.1:9333` 无响应 = 调试端口已关、应用已回到普通启动。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| `open -n -a DoubaoWork --args --remote-debugging-port=9333` 起来后端口不通 | `open --args` 的参数没有传到 Chromium 命令行 | 直接执行 `Contents/MacOS/DoubaoWork --remote-debugging-port=9333` |
| 直接起二进制，日志 `Failed to create …/SingletonLock: Operation not permitted` 后立刻退出 | 启动环境写不了 App 数据目录（被沙箱限制） | 在无该限制的环境里起（本机在 DSH 沙箱内需提权一次），或先让 LaunchServices 正常启动 |
| `tell application "DoubaoWork" to quit` 报 `-10004` | 自动化权限未授权，Apple 事件被拒 | `killall -q DoubaoWork` |
| `.click()` 打开了面板却没反应 / 面板立刻消失 | React 弹层的触发依赖真实指针事件；坐标点偏会命中背景把面板关掉 | 用 `Input.dispatchMouseEvent` 点按钮；面板内操作一律先 `el.focus()` 或 DOM `.click()` |
| 按坐标点搜索框，文字却进了输入框 | 面板关闭后同一坐标落在输入框上 | 输入前断言 `[role=listbox]` 仍存在 |
| `listbox` 的 rect 只有 400 高，但分组标签出现在 y=1056 | rect 只是可视滚动区，内容继续向下延伸 | 用分组标签 / option 的 `getBoundingClientRect()` 判断顺序，不要用父容器高度推断内容 |

## 何时别用

- 只想确认「豆包面板长什么样」：截图 + 本文件就够，不必每次都接管。
- 要读的是对话内容或文档正文：走官方 API / `web_fetch`，开 CDP 是杀鸡用牛刀。
- 要在这台机器上复刻同样的「引用面板」：先看 DSH 侧 `dsh-feishu-ref` 的实现（0.6.0 起就是照这套结构做的），
  不要从零猜；但要记住**豆包面板是自家 App 的排版自由**，DSH 插件受宿主 composer 的 DOM 约束，只能贴着输入框做同样的层叠关系。
