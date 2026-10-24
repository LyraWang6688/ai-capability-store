# computer-use/ — 电脑（桌面）操作文档

上级约定见 [`../README.md`](../README.md)。

## 文档索引

| 文档 | 说明 | 状态 | 实测日期 |
|---|---|---|---|
| [doubao-work/](./doubao-work/README.md) | 豆包工作（DoubaoWork.app）· 3 篇：CDP 接管 / MCP 连接器 / 图片渲染边界 | 已验证 | 2026-10-24 |
| [codex-desktop/](./codex-desktop/README.md) | Codex 桌面版（ChatGPT.app 内的 Codex） | 未验证 | 2026-10-24 |
| [wechat/](./wechat/README.md) | 微信（WeChat.app） | 未验证 | 2026-10-24 |
| [macos/](./macos/README.md) | macOS 桌面操作（系统级：Finder / 系统设置 / 原生 App） | 未验证 | 2026-10-24 |

## 每篇文档必答

| 问题 | 为什么必答 |
|---|---|
| 需要哪些系统权限 | 辅助功能 / 屏幕录制 / 自动化（按 App 授权），缺一个就静默失败 |
| 用的是哪条手段 | `screencapture` / AX API / CGEvent / AppleScript —— 覆盖的 App 范围不同 |
| 怎么证明操作成功 | 截图、AX 属性、剪贴板内容；没有证据的点击等于盲点 |
| 出错怎么回退 | 破坏了什么、怎么撤销 |
| 什么情况下不该用 GUI | 有 CLI / API 时优先走它们，GUI 是最后手段 |

## 命名

**文件夹 = 一个软件，里面的文件 = 这个软件的一个个功能。**

- 同一个软件今天加一个功能、明天加另一个，文档会一篇篇多起来，所以用文件夹收录。
- 文件名就是检索键：`cdp-takeover`、`window-capture`、`ax-tree` —— 让 Agent 只看名字就能
  判断要不要读。避免 `basic-operation`、`misc`、`notes` 这类说了等于没说的名字。
- 还没实测的功能不要建空文档，写在文件夹 README 的「待建功能」表里。
- 只有**不属于任何 App 的通用主题**才单篇放在本层，如 `ax-tree.md`、`cgevent-input.md`。
