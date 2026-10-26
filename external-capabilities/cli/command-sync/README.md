# command-sync

**把你在终端里手动输入的命令，变成一个快捷键面板：⌥X → 搜索 → 回车复制。**

只做一件事：收集你自己在终端里敲过的命令，按「服务器入口 + 最近 7 天高频」展示，选中复制到剪贴板。
外加一栏**剪贴板历史** —— macOS 的剪贴板只有一格，被下一次复制覆盖就没了，这一栏把它补回来。

## 面板结构

```
按 ⌥X
├─ 🌐 服务器入口（3 条）
│    ssh 登录服务器
│    进入服务器项目 <path>（来自 config.serverPaths）
├─ 📋 剪贴板历史（最近 30 条，新 → 旧）
│   你刚才剪切的那段话…            刚刚 · 42 字
│   https://xxx.feishu.cn/docx/…    3 分钟前 · 58 字
├─ 🕘 最近 7 天用得最多的 5 条本地命令
│     （不足 5 条时用最近记录补齐，标记「旧记录」）
└─ ⌨️ 快捷键速查（来自 shortcuts.md + 自动扫 Hammerspoon）
     显示/隐藏 隐藏文件  ·  Finder          ⌘⇧.
     打开命令面板  ·  全局                  ⌥X
     ⚠️ 未登记：capture                     ⌃⌥Z
```

- 选中 = **复制到剪贴板**，不会自动执行；
- 在条目上按 **⌘⏎** = 复制并直接粘回刚才那个 App（省一次 ⌘V）；
- 每次打开面板都会重新读取历史并生成数据（毫秒级）。

## 剪贴板历史（本机记录，不上传）

- 记录器是 `hammerspoon/clip-history.lua`，用 `hs.pasteboard.watcher` 监听变化
  （Hammerspoon 1.1.1 没有 `hs.clipboard` 模块），数据落盘在
  `~/.hammerspoon/clipboard-history.jsonl`，一行一条 `{"t":epoch,"text":"…"}`；
- 只存**文本**：图片、文件不记录；
- **保留条数可配**：`~/.command-sync/config.json` 的 `clipboardHistory.maxEntries`（默认 100，
  最少 3 条）；单条超 20k 字节截断；文件行数超过「上限 × 4」时压缩重写一次；
- 清理**没有定时器**：只有「剪贴板真的变了」那一刻才检查——超过上限就把最老的一条挤掉；
- 同一内容重复出现时**提到最前**，不会留两份；
- **不记录密码**：带 `org.nspasteboard.ConcealedType` / `TransientType` 标记的粘贴板
  （1Password 等密码管理器复制时会打这个标记）一律跳过 —— 但不是所有 App 都会打，
  所以别把它当密码保险箱；
- 面板只显示最近 30 条，更早的留在文件里（可手动 `require("clip-history").clear()` 清空）。


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

## 安装（npm，推荐）

```bash
npm install -g --prefix ~/.local @lyra_wang/command-sync
command-sync install     # 装到 ~/.command-sync + Hammerspoon ⌥X
```

脚本以软链方式指向 npm 包，源码只在 Store/npm 一份。

## 安装（仓库目录直接跑）

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
  "serverPaths": ["/home/ubuntu/project-a", "/opt/project-b"],
  "clipboardHistory": { "maxEntries": 100 }
}
```

- `sshHost` / `sshUser`：面板里"ssh 登录服务器"用的地址；
- `serverPaths`：面板里"进入服务器项目"的列表；
- `clipboardHistory.maxEntries`：剪贴板历史保留多少条（默认 100，范围 3–500）。
  改完要 `hs -c 'hs.reload()'` 或重开面板才生效（模块加载时读一次配置）。
  例如只想留最近 6 条：`"maxEntries": 6` → 复制第 7 条时，最老的那条被挤掉。

## 自检 / 手动命令

```bash
command-sync doctor                     # 自检：装没装好、缺哪一步
command-sync install                    # 重装（升级后跑一次，重新软链 palette.py）
command-sync palette                    # 重新生成面板数据
python3 ~/.command-sync/bin/palette.py  # 同上，直接调脚本
```

`doctor` 逐项检查并给出「去哪儿补」：

| 检查项 | 不通过时提示 |
|---|---|
| Python 3 | `xcode-select --install` |
| Hammerspoon 是否安装 | `brew install --cask hammerspoon` |
| Hammerspoon 是否在运行（IPC） | `open -a Hammerspoon` |
| 辅助功能授权（`hs.accessibilityState()`） | 系统设置 → 隐私与安全性 → 辅助功能 → 勾 Hammerspoon |
| 面板文件 / init.lua 挂载 | 重跑 `command-sync install` |
| 终端历史 / 剪贴板历史数据源 | 提示历史文件路径与生成方式 |

有任何 ✗ 就以退出码 1 结束，方便脚本判断；全部通过则退出码 0。

## 边界

- 只复制、不执行命令；
- 不收集 AI 执行的命令；
- 剪贴板历史只存文本、只在本机；图片/文件、密码管理器标记的内容不记录；
- 不做月度巡检（巡检由另一个项目负责）。
