# computer-use/ — 电脑（桌面）操作文档

上级约定见 [`../README.md`](../README.md)。

## 文档索引

| 文档 | 说明 | 状态 | 实测日期 |
|---|---|---|---|
| _待填充_ | | | |

## 每篇文档必答

| 问题 | 为什么必答 |
|---|---|
| 需要哪些系统权限 | 辅助功能 / 屏幕录制 / 自动化（按 App 授权），缺一个就静默失败 |
| 用的是哪条手段 | `screencapture` / AX API / CGEvent / AppleScript —— 覆盖的 App 范围不同 |
| 怎么证明操作成功 | 截图、AX 属性、剪贴板内容；没有证据的点击等于盲点 |
| 出错怎么回退 | 破坏了什么、怎么撤销 |
| 什么情况下不该用 GUI | 有 CLI / API 时优先走它们，GUI 是最后手段 |

## 命名

`<平台或主题>.md`：`macos-permissions.md`、`ax-tree.md`、`cgevent-input.md`。
