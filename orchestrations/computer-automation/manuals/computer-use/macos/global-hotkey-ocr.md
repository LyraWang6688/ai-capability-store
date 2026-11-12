# 识图全局热键（Hammerspoon ⌃Q）：框选 → 本地 OCR → 落到光标处

> 环境：macOS 27.0.1 / Hammerspoon（辅助功能 + 屏幕录制已授权）/ `@lyra_wang/image-ocr-cli` 0.1.0（引擎装在 `$HOME/.local/bin/image-ocr`）
> 实测日期：2026-11-12
> 验证方式：`_G.dshOcrClipboard()` 冒烟（剪贴板放已知文字的测试图 → 日志 `ocr ok: 2 lines`）+ 合成 ⌃Q 与合成鼠标拖选（Preview 显示测试图）→ 剪贴板得到 OCR 文本；另在 TextEdit 里合成 ⌘V 后 ⌘S 保存，比对文件内容与剪贴板一致
> 结论：已验证 —— 本机全链路（热键 → 框选 → 引擎 → 剪贴板 → 粘贴）跑通；其它机器、以及目标 App 不接受粘贴的情况未覆盖

## 权限前提

| 权限 | 谁需要 | 缺了会怎样 |
|---|---|---|
| 辅助功能 | Hammerspoon | 全局热键不响应；合成的 ⌘V 不生效（这是最容易静默失败的一项） |
| 屏幕录制 | 调 `screencapture` 的进程（这里是 Hammerspoon） | 框选能出现，但截出来的图是空白 / 底色，OCR 读不到任何字 |

OCR 本身用 macOS Vision，离线，不需要联网、不需要任何账号。引擎由 `image-ocr-cli` 包
首次调用时用 `xcrun swiftc` 编译，所以还需要 Xcode Command Line Tools。

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| `image-ocr`（`@lyra_wang/image-ocr-cli`） | npm CLI | `--clipboard`：读剪贴板里的图出文字；也可直接识别图片文件 | `npm i -g --prefix $HOME/.local @lyra_wang/image-ocr-cli`；macOS + Xcode CLT；首次调用编译 30–60 秒 |
| Hammerspoon | 常驻 GUI App | 注册系统级热键、跑 CLI、合成按键 | 辅助功能已授权；配置目录可写 |
| `hs`（Hammerspoon 的 CLI） | 命令行 | 从终端 reload 配置、查已注册热键、调测试钩子 | Hammerspoon 已开 `hs.ipc` |
| `/usr/sbin/screencapture` | 系统 CLI | `-i -c`：交互框选，结果直接进剪贴板 | 屏幕录制授权；必须在 GUI 会话里执行 |
| `hs.pasteboard` / `hs.eventtap` | Hammerspoon API | 写剪贴板、合成 ⌘V | 辅助功能 |

## 可复现步骤

**为什么走这条路**：DSH 插件的快捷键（`ctx.shortcuts`）只在 DSH 窗口前台时生效；「任何 App 前台都能按」
必须放在系统层，而插件层注册不了系统级热键（见 `external-capabilities/plugin/dsh/screenshot/README.md`
的「已知边界」）。所以 = Hammerspoon 注册热键 + 复用 Store 里的 `image-ocr` 引擎。

1. **装引擎并确认能用**：

   ```bash
   npm i -g --prefix $HOME/.local @lyra_wang/image-ocr-cli
   $HOME/.local/bin/image-ocr --version     # 0.1.0
   $HOME/.local/bin/image-ocr --engine-path # 引擎缓存路径
   ```

   观察点：`--version` 有输出；第一次真正识别时约 30–60 秒编译，之后 0.5–1 秒。

2. **装脚本**：把下面这段存成 Hammerspoon 配置目录里的 `dsh-ocr-hotkey.lua`，并在 `init.lua` 末尾引入：

   ```lua
   do local ok, err = pcall(dofile, hs.configdir .. "/dsh-ocr-hotkey.lua")
      if not ok then hs.alert.show("dsh-ocr-hotkey 加载失败: " .. tostring(err)) end end
   ```

   然后 `hs -c "hs.reload()"`。
   观察点：`hs -c 'for _,k in ipairs(hs.hotkey.getHotkeys()) do print(k.idx) end'` 里出现 `⌃Q`。

   ```lua
   -- dsh-ocr-hotkey.lua 的关键部分（完整实现见本机 Hammerspoon 配置目录）
   local CONFIG = {
     modifiers = { "ctrl" }, key = "Q",
     engineCandidates = {
       os.getenv("HOME") .. "/.local/bin/image-ocr",
       "/opt/homebrew/bin/image-ocr",
       "/usr/local/bin/image-ocr",
     },
     paste = true, pasteDelay = 0.15, refocusDelay = 0.20,
     logPath = "/tmp/dsh-ocr-hotkey.log",
     -- 关键：GUI 启动的进程 PATH 很窄，里面没有 node；必须给子进程注入 PATH
     childPath = table.concat({
       os.getenv("HOME") .. "/.local/bin",
       "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
     }, ":"),
   }
   -- 核心链路：
   --   1) screencapture -i -c            → 框选进剪贴板
   --   2) env PATH=… image-ocr --clipboard → stdout 为识别文字
   --   3) hs.pasteboard.setContents(text) → 合成 ⌘V → 落到前台 App 光标处
   --   4) 引擎缺失 / 没识别到字 / 截图失败 分别给不同提示，不静默
   ```

3. **冒烟（不碰 GUI）**：把一张已知文字的图放进剪贴板，调用测试钩子
   `hs -c "_G.dshOcrClipboard()"`。
   观察点：日志出现 `ocr ok: N lines`，`pbpaste` 输出的就是识别结果。

4. **全链路**：任意 App 里按 `⌃Q` → 系统十字框选 → 拖出一个包含文字的矩形 → 松手。
   观察点：约 1 秒后出现提示「识图完成 · N 行，已粘贴」，光标处出现文字；剪贴板里也留着同一段文字（粘贴落空时可以再按一次 ⌘V）。
   本次实测：在 Preview 里显示测试图、拖选其文字区域，日志 `capture start → ocr ok: 1 lines, 23 chars → alert: 识图完成 · 1 行，已粘贴`。

5. **收尾 / 回退**：删掉 `dsh-ocr-hotkey.lua`，并把 `init.lua` 里那两行注释掉，`hs -c "hs.reload()"`。
   观察点：热键列表里不再有 `⌃Q`。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 按 ⌃Q 完全没反应 | Hammerspoon 缺辅助功能；或 `init.lua` 里 dofile 失败（会在屏幕顶部弹提示） | 系统设置 → 隐私与安全性 → 辅助功能 勾上 Hammerspoon；看 `hs.console` 报错 |
| 提示「识图失败：env: node: No such file or directory」 | Hammerspoon 是从 GUI 启动的，PATH 里没有 Homebrew / node，`#!/usr/bin/env node` 找不到解释器 | 用 `/usr/bin/env PATH=… image-ocr` 启动，显式给出含 node 的 PATH（见上面脚本的 `childPath`） |
| 引擎编译失败，报 `unable to open output file …/ModuleCache/…pcm: Operation not permitted` | 调用方处在受限文件沙箱里，swiftc 想写系统默认 module cache | 让编译产物与 module cache 都落在自己的缓存目录（`swiftc -module-cache-path`），或在非沙箱进程里首次编译 |
| 识别返回 `[OCR 失败] unknownError` | 在受限沙箱里执行时 Vision 拿不到所需资源 | 在非沙箱进程里调用（Hammerspoon / 普通终端都正常）；这不是引擎代码问题 |
| 框选完提示「没识别到文字」 | 选区太小 / 对比度太低 / 里面本来就没字 | 放大选区，或放大图片再框 |
| 按 Esc 取消耗了一次误报 | `screencapture -i` 取消时**退出码可能是 0**，不是 1 | 用「剪贴板里有没有出现新图」判断取消，别只看退出码；否则每次取消都会弹一次「没截到图」 |
| 识别出来少字/错字（实测出现「只图测试」而非「识图测试」） | 框选起点切掉了字的左半边，OCR 只能读残形 | 框选时把文字整行包进去，留点边距 |
| 粘贴落到了别的窗口 | OCR 那一秒里焦点被切走 | 脚本会记住按热键时的前台 App，粘贴前发现焦点变了会先切回去再粘 |

## 何时别用

- 只在 DSH 里识图：直接用插件的「＋ 识图」按钮。它和本热键调用**同一个引擎**（`@lyra_wang/image-ocr-cli`），
  不需要系统级热键，也不需要 Hammerspoon。
- 只要文字、不需要落到光标处：macOS 快捷指令（「截屏」类型选「交互」→「从图像中提取文本」→「合并文本」→「拷贝至剪贴板」）更轻，不常驻进程，但最后要自己按 ⌘V。
- 批量图片转文字：直接用 `image-ocr 图片.png`，别走 GUI 热键。
- 没有 Hammerspoon（或不想常驻进程）：走上面那条快捷指令，或直接用 `image-ocr` 命令。
