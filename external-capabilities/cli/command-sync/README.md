# command-sync

**把你在终端里高频输入的命令，变成一个快捷键面板：⌥X → 搜索 → 回车复制。**

再加上一条月度巡检：自动发现"新出现但还没沉淀"的命令和服务器项目变化。

## 两个能力

| 能力 | 入口 | 说明 |
|---|---|---|
| **命令面板** | `⌥X` | 三组：🌐 服务器入口 / 🕘 最近用过 / ⌘ 高频命令；选中复制到剪贴板 |
| **月度巡检** | `launchctl`（每月 1 号 21:00） | 对比历史与快照，发现新命令 / 服务器项目变化 / 上游仓库归档或删除 |

## 数据来源（只读，不执行任何命令）

- `~/.zsh_history`（你自己的手动输入，不含 AI 执行的命令）；
- 可选的 `fc -l` 转储（`history-dump*.txt`，用于补齐内存里未落盘的历史）；
- 服务器项目列表来自 `~/.command-sync/config.json` 的 `serverPaths`。

## 安装

前置：Python 3（系统自带）、Hammerspoon（`brew install --cask hammerspoon`，面板宿主，免费开源）。

```bash
# 在本目录执行
./install.sh
```

安装器会：

1. 把脚本复制到 `~/.command-sync/bin/`；
2. 生成 `~/.command-sync/config.json`（从 `~/.ssh/config` 推断主机，可手工补 `serverPaths`）；
3. 注册 launchd 月度巡检；
4. 写入 `~/.hammerspoon/command-palette.lua` 并在 `init.lua` 里挂上引用；
5. 生成第一份 `palette.json`。

> 首次使用需要在「系统设置 → 隐私与安全性 → 辅助功能」勾选 **Hammerspoon**。

## 建议的历史设置（否则面板数据是旧的）

zsh 默认只在终端退出时写历史。把下面三行加进 `~/.zshrc`：

```zsh
setopt INC_APPEND_HISTORY EXTENDED_HISTORY
HISTSIZE=10000
SAVEHIST=10000
```

新开的终端立即生效。若想补齐当前已开终端的历史，在终端里执行：

```bash
fc -l -3000 > ~/.command-sync/history-dump-$(date +%H%M%S).txt
```

## 配置（`~/.command-sync/config.json`）

```json
{
  "history": "~/.zsh_history",
  "sshHost": "your.server.ip",
  "sshUser": "ubuntu",
  "serverPaths": ["/home/ubuntu/project-a", "/opt/project-b"]
}
```

## 手动命令

```bash
python3 ~/.command-sync/bin/palette.py     # 重新生成面板数据
python3 ~/.command-sync/bin/scan.py all     # 巡检：新命令 / 服务器项目
python3 ~/.command-sync/bin/scan.py verify  # 文档与快照一致性自检
bash ~/.command-sync/bin/run-check.sh       # 完整月度检查（含 verify）
```

## 目录

```
~/.command-sync/
├── config.json          # 你的配置（ssh 主机、服务器项目路径）
├── bin/                 # palette.py / scan.py / run-check.sh
├── palette.json         # 面板数据（自动生成）
├── known-*.json         # 巡检快照
├── git-commands.md      # 沉淀文档（由 AI 在确认后补写）
├── other-commands.md
├── server-projects.md
├── pending.md           # 待沉淀清单（巡检发现变化时生成）
├── reports/             # 每次巡检报告
└── logs/
```

## 边界

- 面板**只复制、不执行**命令（`npm publish`、`ssh` 这类需要确认的操作，由你自己粘贴后回车）；
- 巡检脚本**只读**历史与服务器，不在服务器写任何东西；
- 不收集 AI 执行的命令。
