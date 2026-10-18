# ai-quote-clip

**把 AI 说得好、值得留下的句子，一键收进飞书。**

和 ChatGPT / Codex / 豆包工作聊出来的好表达、好观点，选中 → 按 `⌃⌥Z`（可改）→ 直接追加到你的飞书文档。
任何 App（浏览器、编辑器、AI 客户端）都适用。

## 为什么需要它

- 想学 AI 的表达方式，却总是"看完就忘"；
- 手动复制 → 切到飞书 → 找文档 → 粘贴，步骤太多，思路被打断；
- 浏览器剪藏插件只能收网页，**收不了 AI 对话**。

## 安装

```sh
npm i -g ai-quote-clip      # 或 npx ai-quote-clip
ai-quote-clip init
```

`init` 会：检查 lark-cli → 让你贴一个飞书文档 URL → 验证可读 → 写配置（`~/.ai-quote-clip/config.json`，600）→ 安装 `⌃⌥Z` 快捷键。

### 快捷键用什么实现（0.2.0 起）

默认走 **[Hammerspoon](https://www.hammerspoon.org/)**（免费开源、Apple 公证签名）：`hotkey install` 会写入
`~/.hammerspoon/ai-quote-clip.lua` 并在 `init.lua` 里挂上引用。

1. `brew install --cask hammerspoon`
2. `ai-quote-clip hotkey install`（默认 `--mode hammerspoon`）
3. 系统设置 → 隐私与安全性 → 辅助功能 → 勾选 **Hammerspoon**（一次即可，之后不会失效）

**为什么不用自带的小 App**：它未签名，macOS 每次重编译都会作废辅助功能授权。自研 App 仍可用 `--mode app` 安装，仅作备用。

### 关于"复制"

读取选区在 macOS 上只能通过模拟一次 `⌘C` 完成（Electron 类应用不暴露选区）。工具会先**清空剪贴板**再复制，只接受"本次选中"的内容，然后**还原你原来的剪贴板**；没有选中时提示"没有选中文字"，不会收录旧内容。

## 用法

| 动作 | 命令 |
|---|---|
| 选中文字后按快捷键 | `⌃⌥Z`（默认经 Hammerspoon，首次需在"系统设置 → 隐私与安全性 → 辅助功能"勾选 Hammerspoon） |
| 收录剪贴板 | `ai-quote-clip add --clipboard` |
| 收录一段文字 | `ai-quote-clip add "要收录的文字"` |
| 管道 | `echo "文字" | ai-quote-clip add` |
| 切换目标文档 | `ai-quote-clip doc set <URL|token>` |
| 查看状态 | `ai-quote-clip status` |
| 换快捷键字母 | `ai-quote-clip hotkey install --key w`（支持 a–z） |
| 用自研 App 模式 | `ai-quote-clip hotkey install --mode app`（备用；macOS 对未签名 App 的授权可能不稳定） |
| 卸载快捷键 | `ai-quote-clip hotkey uninstall` |

收录格式：

```markdown
> 你选中的原文

收录：2026-10-19 04:40　来源：ChatGPT

---
```

## 前置条件

- Node.js ≥ 20
- 本机 `lark-cli` 已授权（需要 docs 域；`lark-cli auth login --domain docs`）
- 一个你有编辑权限的飞书文档
- 快捷键仅 macOS（Hammerspoon 模式需先 `brew install --cask hammerspoon`）；CLI 本身跨平台

## 隐私与安全

- 内容只写进**你自己指定**的飞书文档；
- 本仓库/本包**不含任何凭据**：飞书令牌在 lark-cli 自己的凭据库，配置里只有文档 token；
- 快捷键需要"辅助功能"权限（用于模拟 ⌘C 读取你选中的文字），随时可在系统设置里撤销。

## 许可证

MIT
