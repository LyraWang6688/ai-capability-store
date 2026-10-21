# image-ocr

**在 DSH 输入框点「＋ 识图」，把剪贴板里截图上的文字识别出来，直接插入草稿。**

截图（⌃⌘⇧4 或任意截图工具）→ 点「＋ 识图」→ 文字出现在输入框，接着问 agent。

## 原理

- 用 macOS 自带 **Vision** 框架做 OCR（离线、免费、中文支持好）；
- 插件带一份 `ocr.swift`，首次使用时用 `xcrun swiftc` 编译，缓存到
  `~/Library/Application Support/dsh-image-ocr/ocr`；
- 之后每次识别约 **0.6–1 秒**（实测整屏截图 53 行 0.66s）；
- 宿主侧注册一个同源只读路由 `/plugins/image-ocr/ocr`，复用 DSH 连接鉴权。

## 使用

1. 截图到剪贴板（系统默认 ⌃⌘⇧4 选区域，或 ⌃⌘⇧3 全屏）；
2. 输入框左侧点「＋ 识图」；
3. 识别结果插入草稿（可撤销），底部提示行数；
4. 第一次点可能需要等 30–60 秒（在编译 OCR 引擎），之后再点就很快。

## 安装

```bash
dsh plugin --profile <profile> add @lyra_wang/dsh-image-ocr
```

前置：macOS 13+ 且装有 Xcode Command Line Tools（`xcrun --find swiftc` 有输出即可）。

## 边界

- 只读剪贴板里的图片，不读屏幕、不自动截图；
- 不联网，图片不出本机；
- 手写体/低分辨率截图识别率有限，建议放大后再截。
