# command-sync

**把你在终端里手动输入的命令，变成一个快捷键面板：⌥X → 搜索 → 回车复制。**

只做一件事：收集你自己在终端里敲过的命令，按「服务器入口 + 最近 7 天高频」展示，选中复制到剪贴板。

## 面板结构

```
按 ⌥X
├─ 🌐 服务器入口（3 条）
│    ssh 登录服务器
│    进入服务器项目 <path>（来自 config.serverPaths）
└─ 🕘 最近 7 天用得最多的 5 条本地命令
     （不足 5 条时用最近记录补齐，标记「旧记录」）
```

- 选中 = **复制到剪贴板**，不会自动执行；
- 每次打开面板都会重新读取历史并生成数据（毫秒级）。

## 数据来源（只读）

- `~/.zsh_history`（只含你手动输入的命令，不含 AI 执行的）；
- 可选的 `history-dump*.txt`（`fc -l` 转储，用于补齐内存里未落盘的历史）；
- 服务器入口来自 `~/.command-sync/config.json`。

## 安装

前置：Python 3（系统自带）、Hammerspoon（`brew install --cask hammerspoon`，面板宿主，免费开源）。

```bash
./install.sh
```

安装器会：复制脚本到 `~/.command-sync/bin/`、生成 config、写入 Hammerspoon 面板配置、生成首份数据。

> 首次使用需在「系统设置 → 隐私与安全性 → 辅助功能」勾选 **Hammerspoon**。

## 建议的 zsh 历史设置

zsh 默认只在终端退出时写历史。把下面三行加进 `~/.zshrc`：

```zsh
setopt INC_APPEND_HISTORY EXTENDED_HISTORY
HISTSIZE=10000
SAVEHIST=10000
```

若要补齐当前已开终端的历史：

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

- `sshHost` / `sshUser`：面板里"ssh 登录服务器"用的地址；
- `serverPaths`：面板里"进入服务器项目"的列表。

## 手动命令

```bash
python3 ~/.command-sync/bin/palette.py   # 重新生成面板数据
```

## 边界

- 只复制、不执行命令；
- 不收集 AI 执行的命令；
- 不做月度巡检（巡检由另一个项目负责）。
