# readloop-extension-pack

把 `external-capabilities/plugin/readloop-extension/` 打成可分发的 zip，并做版本/文件清单校验。

## 跑什么

```bash
node procedures/readloop-extension-pack/pack.mjs
# 可选：--source <插件目录> --out <输出目录>
```

产物：`<out>/readloop-extension-<manifest.version>.zip`（默认 `dist/`，已 gitignore）。

## 前提

- Node.js ≥ 18
- 系统有 `zip` 与 `unzip`（macOS/Linux 自带）

## 它校验什么

- `manifest.json` 可解析、`manifest_version === 3`、`version` 为 X.Y.Z
- 运行时文件齐全（background / content-script / sidepanel / lib / 图标）
- 包内版本 = 源版本；`tools/` 不会进包；`.DS_Store` 不会进包

## 自测

```bash
node procedures/readloop-extension-pack/pack.mjs --self-test
```

## 什么时候别用

- 只想本地 Load unpacked：直接把插件目录选进去，不需要打包
- Chrome Web Store 上架：仍需人工上传 zip 并填表

## 发布

```bash
node procedures/readloop-extension-pack/pack.mjs
gh release create readloop-extension-v<version> dist/readloop-extension-<version>.zip \
  --title "ReadLoop Chrome Extension v<version>" --notes "..."
```
