# 文档契约 — 两类文档的必答问题

上级规则：[`../../computer-automation/README.md`](../../computer-automation/README.md)。
本文件说明「一篇合格文档长什么样」，`scripts/check_doc.py` 按本文件检查。

## 所有文档共有：抬头四条

正文第一段（标题之后、第一个 `##` 之前）必须逐行给出：

```markdown
> 环境：macOS 15 / DSH 桌面端 / Chrome 已登录
> 实测日期：2026-10-24
> 验证方式：手工执行 + 截图确认 + DOM 断言
> 结论：已验证 —— 能稳定打开目标页并读到表格数据
```

| 字段 | 要求 | 不合格写法 |
|---|---|---|
| 环境 | OS、宿主、关键版本；不写账号 | 「Mac」 |
| 实测日期 | `YYYY-MM-DD`，必须是真实跑过的日期 | 抄别人的日期 / 留空 |
| 验证方式 | 拿什么证据判断生效（截图 / 快照 / 断言 / 剪贴板） | 「看了一下」 |
| 结论 | 一句话：已验证 / 未验证，以及卡在哪 | 「可用」 |

## Browser Use 文档 · 必答小节

| 小节 | 答案里必须出现 |
|---|---|
| `## 入口` | 是 MCP server、CLI 还是直接 CDP；宿主怎么接上（命令、参数、端口） |
| `## 浏览器会话` | 独立实例还是复用操作者已登录的 Chrome；会不会碰到真实账号数据 |
| `## 如何验证` | 至少一种可复查的证据（页面快照 / DOM 断言 / 截图文件名） |
| `## 何时别用` | 反例 + 该走哪条替代路径 |
| `## 已知坑` | 实际踩到的，写清触发条件；没踩到就写「暂无」 |

## Computer Use 文档 · 必答小节

| 小节 | 答案里必须出现 |
|---|---|
| `## 权限前提` | 辅助功能 / 屏幕录制 / 自动化，缺哪个会静默失败 |
| `## 操作手段` | `screencapture` / AX API / CGEvent / AppleScript，以及为什么选它 |
| `## 如何验证` | 证明操作真的发生：截图、AX 属性、剪贴板内容 |
| `## 回退` | 做坏了怎么撤（撤销键、备份、重开窗口） |
| `## 何时别用` | 有 CLI / API 时的优先路径；GUI 是最后手段 |

## 合格范例（Browser Use，节选）

```markdown
# Chrome DevTools MCP 连接操作者自己的 Chrome

> 环境：macOS / DSH 桌面端 / chrome-devtools-mcp / Chrome 已登录常用站点
> 实测日期：2026-10-24
> 验证方式：list_pages 返回真实标签页列表；导航后取页面快照核对标题
> 结论：已验证 —— 能读到操作者已登录的会话

## 入口

宿主 `cordis.patch.yml` 里以 `dsh-mcp-client` 插入，stdio，命令
`npx -y chrome-devtools-mcp@latest --autoConnect`。

## 浏览器会话

复用操作者自己的 Chrome（`--autoConnect`），因此带登录态；
代价是 Chrome 必须运行且远端调试开关打开，并会弹连接授权。

## 如何验证

`list_pages` 返回的标签页与用户屏幕上一致；导航后快照里的标题与预期相同。

## 何时别用

只需要干净环境、可重复的回归验证时，改用 Playwright MCP 的独立实例；
不需要交互、只读内容时用 `web_fetch`。

## 已知坑

- `--autoConnect` 依赖 Chrome 侧开启远端调试；关掉后 MCP 仍注册但调用失败。
- 标签页 id 会随用户操作漂移，操作前重新 `list_pages`。
```

## 反例（会被门禁或人工打回）

| 写法 | 问题 |
|---|---|
| 「打开浏览器，点一下，成功了」 | 没有入口、没有会话归属、没有证据 |
| 贴整段页面正文 / 聊天记录 | 个人信息进公开仓库 |
| `https://example.com/x?token=...` | URL 带凭据参数 |
| 「应该可以」「理论上支持」 | 未验证却写成事实 |
| 只写「暂无坑」但没跑过 | 空话，不如写「未验证 + 卡在哪」 |

## 命名

`<工具或主题>.md`，kebab-case：`chrome-devtools-mcp.md`、`playwright-mcp.md`、
`macos-permissions.md`、`ax-tree.md`。一篇文章只讲一件事。

## 一个 App 多篇文档时：用文件夹

**一个 App 一个文件夹。** 哪怕现在只有一条操作路径，也先建文件夹——后续那条路径
迟早会长出来，事后再搬一次只会多一次链接修复。

不要把多条路径塞进一篇，也不要命名成 `app-a.md`、`app-b.md` 散在目录里。

```text
computer-automation/computer-use/
├── README.md                 # 总索引：列出所有文档，含子目录入口
├── <topic>.md                # 单篇主题（与此前一致）
└── <app>/
    ├── README.md             # 该 App 的主题索引 + 特征表 + 一句话选路
    └── <topic>.md            # 每条操作路径一篇，照上面的必答小节写
```

规则：

- 子目录里的**每一篇**仍然要满足本文档的抬头四条与必答小节（按所在域判定：`computer-use/` 或 `browser-use/`）。
- 子目录的 `README.md` 必须列出内部每一篇；上级 `README.md` 必须登记 `./<app>/README.md`。
- **`README.md` 不是文档**，不对它跑门禁；它负责导航，不承担必答小节。
- 只有**不属于任何 App 的通用主题**（`ax-tree.md`、`cgevent-input.md`）才单篇放在域目录下。
