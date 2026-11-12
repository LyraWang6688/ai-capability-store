# image-ocr-cli

**命令行版「识图」：把一张图（或剪贴板里的截图）上的文字识别出来，输出到 stdout。**

macOS 自带 **Vision** 框架，离线、免费、中文支持好；图片不出本机。

同一份引擎同时服务两个调用方：

```
        image-ocr（本包）
           ↑              ↑
   DSH 插件调它      ⌃Q 全局热键调它
```

- DSH 插件 [`image-ocr`](../../plugin/dsh/image-ocr/)（按钮「＋ 识图」）把它当依赖；
- 系统级热键（Hammerspoon 等）直接调本包的 `image-ocr` 命令。

引擎源码只有这一份（[`ocr.swift`](./ocr.swift)），不再存在"插件里一份、CLI 里一份"的分叉。

## 安装

```bash
npm i -g --prefix ~/.local @lyra_wang/image-ocr-cli
# 之后：~/.local/bin/image-ocr
```

前置：macOS 13+ 且装有 Xcode Command Line Tools（`xcrun --find swiftc` 有输出即可）。

## 用法

```bash
image-ocr 截图.png              # 识别文件
image-ocr                       # 识别剪贴板里的图（先 ⌃⌘⇧4 截一张）
image-ocr --clipboard --json    # {"ok":true,"text":"…","lines":2}
image-ocr --engine-path         # 编译后的引擎在哪
```

| 退出码 | 含义 |
|---|---|
| `0` | 成功（stdout 是文字） |
| `1` | 识别失败（错误原因在 stderr） |
| `2` | 用法错误 |
| `4` | 没有可识别的图片，或没识别到文字 |

## 引擎与缓存

- 首次调用用 `xcrun swiftc -O` 编译 `ocr.swift`，约 **30–60 秒**；之后热启动约 **0.5–1 秒**；
- 编译产物缓存在 `~/Library/Caches/lyra-wang-image-ocr/ocr-<源码哈希>`；
- **缓存键是源码哈希**，所以升级包之后一定重新编译，不会继续用旧二进制；
- 想强制重编：`rm -rf ~/Library/Caches/lyra-wang-image-ocr`。

## 作为库使用

```js
import { runOcr, ensureEngine } from '@lyra_wang/image-ocr-cli';

await ensureEngine();                        // 可选：提前预热，别让第一次调用等编译
const text = await runOcr({ imagePath: '/path/to/shot.png' });
const fromClipboard = await runOcr();        // 不给路径 = 读剪贴板
```

`runOcr` 抛错时 message 已经是中文原因（编译失败 / 执行失败），调用方可以直接展示。

## 边界

- 只处理给它的图片，不读屏幕、不自动截图；
- 不联网，图片不出本机；
- 手写体 / 低分辨率识别率有限，建议放大后再截；
- macOS only（Vision + `xcrun swiftc`）。
