# Computer Automation Domain — 界面能被怎么操作

**Domain: Computer Automation = What a third party's interface lets us do, and how we know.**

这个域收的不是 Skill，也不是脚本。它收的是**一个界面**：豆包工作的窗口、Chrome 里的
DeepSeek 账单页、微信的聊天框、终端里的一个 TUI。

**为什么它必须单独成一个域**

不是因为它图形化。是因为它是**唯一会被第三方单方面、静默地作废**的资产：

| 依赖形态 | 别人改了会怎样 | 我们多久知道 |
|---|---|---|
| API | 报错（版本号 / 错误码 / 402） | 立刻 |
| CLI | 报错（参数不认识 / 命令不存在） | 立刻 |
| **界面** | **不报错**。脚本照跑，只是点错地方、读不到数、提交了错的表单 | **可能一个月后** |

这不是假设。`deepseek-invoice` 的 0.1.2 patch 修的就是这个：金额读不到时
`Number(... || '0')` 把 null 转成 0，于是走进「本月无可开额度，跳过」并返回 `ok:true`
——一个月没开票，日志里一切正常。修复后它有了 `AMOUNT_UNREADABLE` 与退出码 4。

所以本域的资产和别处**不是一个物种**：`skills/` 的失效靠人用着觉得不对，
`procedures/` 的失效靠测试或报错，而本域的失效**只有主动复核才会被发现**。
这就决定了它需要自己的字段（`verified`）、自己的状态词汇、自己的复核节奏——
这三样在别的域里无处安放。

**判据**：接口由别人拥有，且改动不通知我们。满足这条的，哪怕不是图形界面
（例如靠读屏幕驱动一个 TUI），也属于本域；不满足的，哪怕有窗口（例如
`--help` 稳定的命令行工具），也不属于。

## 本域不收什么

| 不收 | 去哪 |
|---|---|
| 确定性的操作脚本 | `procedures/` |
| 需要模型现场判断的操作 | `skills/` |
| 有 API / MCP / 稳定 CLI 的系统 | `external-capabilities/` |

**"Browser Use 里既有 Skill 又有确定性脚本"**这句话是对的，但它是**引用**关系，
不是容纳关系：`driven_by` 指向真正干活的资产，那些资产仍然住在自己的域里，
各自是唯一事实源。本域只回答"这个界面能怎么被操作、我们上次验证是什么时候"。

## Placement

```text
computer-automation/
├── registry.yaml
├── README.md              本文件
├── browser-use/<app>/     浏览器里的界面（一个界面一个文件夹）
│   ├── README.md          该界面的档案：入口 / 会话 / 工具 / 已验证的结论
│   └── <topic>.md         具体功能怎么操作
└── computer-use/<app>/    桌面 / 系统界面（同上结构）
```

**文件夹 = 一个界面，文件 = 这个界面的一个功能。** 文件名是 Agent 的检索键，
要能只看名字判断"该不该读"。反例：`basic-operation` / `misc` / `notes`。

## 注册表字段

必需：`name` / `path` / `facet` / `platform` / `drive` / `verified`。

- `facet` ∈ `browser` / `computer` —— 作用域，就是你说的 Browser Use / Computer Use
- `platform` —— `web` / `macos` / `linux` / `windows`
- `drive` —— 能被什么驱动：`cdp` / `playwright` / `ax` / `cgevent` / `applescript` /
  `screencapture` / `mcp`
- `blocked` —— 哪些路已经死了，以及为什么（例如辅助功能未授权 `-10004`）
- `verified` —— **上次实测日期**。这是本域特有的字段，本域存在的理由就是它
- `driven_by` —— 引用真正干活的资产（`procedures/...` 或 `skills/...`），不复制
- `docs` —— 该界面的文档目录

## 复核节奏

`verified` 超过一个季度，或者该平台的界面/版本有变动的迹象，状态降为 `unverified`。
`unverified` 不代表不能用了，代表"别照抄，先自己验一遍"。这条规则来自本域的性质：
**它的失效不会自己报错**。

## Commerce

本域的资产本身**不收费**（它是档案，不是能力）。收费发生在它引用的东西上：
`driven_by` 指向的 procedure / skill 才带 `commerce`。
本域记录强制 `commerce: {charge: free}`——沿用 `COMMERCE.md` 对 Automation 的同一条
理由：不是可以卖给消费者的交付物。
