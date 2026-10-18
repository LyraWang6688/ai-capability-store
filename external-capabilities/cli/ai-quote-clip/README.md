# ai-quote-clip

**把 AI 说得好、值得留下的句子，一键收进飞书。**

和 ChatGPT / Codex / 豆包工作聊出来的好表达、好观点，选中 → 按 `⌃⌥S` → 直接追加到你的飞书文档。
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

`init` 会：检查 lark-cli → 让你贴一个飞书文档 URL → 验证可读 → 写配置（`~/.ai-quote-clip/config.json`，600）→ 安装 `⌃⌥S` 快捷键（macOS，需 Xcode Command Line Tools）。

## 用法

| 动作 | 命令 |
|---|---|
| 选中文字后按快捷键 | `⌃⌥S`（首次需在"系统设置 → 隐私与安全性 → 辅助功能"勾选 AiQuoteClip） |
| 收录剪贴板 | `ai-quote-clip add --clipboard` |
| 收录一段文字 | `ai-quote-clip add "要收录的文字"` |
| 管道 | `echo "文字" | ai-quote-clip add` |
| 切换目标文档 | `ai-quote-clip doc set <URL|token>` |
| 查看状态 | `ai-quote-clip status` |
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
- 快捷键仅 macOS；CLI 本身跨平台

## 隐私与安全

- 内容只写进**你自己指定**的飞书文档；
- 本仓库/本包**不含任何凭据**：飞书令牌在 lark-cli 自己的凭据库，配置里只有文档 token；
- 快捷键需要"辅助功能"权限（用于模拟 ⌘C 读取你选中的文字），随时可在系统设置里撤销。

## 许可证

MIT
