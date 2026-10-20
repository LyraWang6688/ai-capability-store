# command-sync

**把你在终端里手动输入的命令，变成一个快捷键面板：⌥X → 搜索 → 回车复制。**

只做一件事：收集你自己在终端里敲过的命令，按「服务器入口 + 最近 7 天高频」展示，选中复制到剪贴板。

## 面板结构

```
按 ⌥X
├─ 🌐 服务器入口（3 条）
│    ssh 登录服务器
│    进入服务器项目 <path>（来自 config.serverPaths）
├─ ⌨️ 快捷键速查（来自 shortcuts.json + 自动扫 Hammerspoon）
│    显示/隐藏 隐藏文件  ·  Finder          ⌘⇧.
│    打开命令面板  ·  全局                  ⌥X
│    ⚠️ 未登记：capture                     ⌃⌥Z
└─ 🕘 最近 7 天用得最多的 5 条本地命令
     （不足 5 条时用最近记录补齐，标记「旧记录」）
```

- 选中 = **复制到剪贴板**，不会自动执行；
- 每次打开面板都会重新读取历史并生成数据（毫秒级）。

## 数据来源（只读）

- `~/.zsh_history`（只含你手动输入的命令，不含 AI 执行的）；
- 可选的 `history-dump*.txt`（`fc -l` 转储，用于补齐内存里未落盘的历史）；
- 服务器入口来自 `~/.command-sync/config.json`；
- 快捷键（`~/.command-sync/shortcuts.md`，一行一条，纯文本）：
  - **`selection-toolbar` 插件**：在对话里选中一句话（例如「⌘⇧. 显示/隐藏隐藏文件」），
    点工具条上的 **「快捷键」** 按钮，就追加一行 —— 不需要按键捕获，也不需要记格式；
  - 也可以直接编辑这个文件；
  - 另外会**自动扫** `~/.hammerspoon/*.lua` 里的 `hs.hotkey.bind`，
    扫到但上面没存的显示成「⚠️ 未登记：<函数名>」。

  旧的 `shortcuts.json` 写法已废弃：两个组件各写各的字段格式就会漂移，
  而这个文件的全部职责只是记住一句话。

  - `~/.command-sync/shortcuts.json`（手动维护 —— 系统 / 其他 App 的快捷键没法自动发现）；
  - **自动扫** `~/.hammerspoon/*.lua` 里的 `hs.hotkey.bind`。

  > 扫到但 `shortcuts.json` 里没有的，显示成 **「⚠️ 未登记：<函数名>」**。
  > 没有这个机制，你新加的快捷键永远不会出现在面板里 —— 而面板的意义就是
  > 「记不住的时候有个地方找」。补上描述后会变成正常条目。

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
