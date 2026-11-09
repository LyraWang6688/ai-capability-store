# @lyra_wang/dsh-screenshot

输入框左侧多一个「＋ 截图 ⌥S」按钮：按下（或直接按 **⌥S**）→ 系统框选屏幕（空格可切换成「选窗口」）→ 截好的图**直接作为附件进入草稿**，不用剪贴板、不用切 App。

对齐豆包工作 / Codex 的「应用截图」用法，但走的是 DSH 自己的附件管线。

## 为什么是 Host + Client 两半

| 半边 | 干什么 | 为什么不能放在一起 |
|---|---|---|
| Host (`index.js`) | 注册 `POST /plugins/screenshot/capture`，调 macOS `screencapture`，把 PNG 原样返回 | 浏览器页面无法打开系统截图 UI；`screencapture` 是同一 GUI 会话里的普通 CLI |
| Client (`client.js`) | 在 `conversation.input.left` 注册按钮；用 `ctx.shortcuts.register` 注册 ⌥S 命令；拿到 PNG 后交给输入框 | 草稿附件的 id 与上传状态由 composer 自己持有，插件只能把 `File` 交回给它的 intake 路径 |

Client 侧**不直接调上传 API**：`ctx.fileUpload.upload()` 只返回服务端凭据，而草稿附件需要客户端自己生成 id + 上传状态表。把图片做成 `File` 后合成一次 `paste` 事件（`ClipboardEvent` + `DataTransfer`），输入框就会走和用户手动粘贴完全相同的代码路径：上传 → 缩略图 → 可删除附件。找不到编辑器时退回「文件选择 input + change 事件」。

## 前台条件

- macOS（使用系统 `screencapture`）
- DSH Desktop 需要**屏幕录制**权限（系统设置 → 隐私与安全性 → 屏幕录制）。Host 进程实测可直接调用 `screencapture`；如果截图返回空白/失败，先检查这一项。

## 用法

1. 在对话输入框左侧点「＋ 截图」，或**在 DSH 窗口里直接按 ⌥S**。
2. 屏幕出现框选十字：拖拽选区域；按 **空格** 切换成窗口选择；按 **Esc** 取消。
3. 松手后图片出现在草稿的附件区，和粘贴截图完全一样（可删除、可随消息发出）。

顶部会有一条短暂提示告诉你当前状态（框选中 / 已加入 / 出错原因）。

## 快捷键是怎么来的

DSH 的 Client 插件 API 里有一个 `shortcuts` 服务（`ctx.shortcuts`，由
`@deepseek-ai/dsh-client-shortcuts` 提供，Web App 在**设置 → 快捷键**里用的就是它）。
插件注册一条命令，而不是自己监听 `keydown`：

```js
ctx.shortcuts.register({
  id: 'screenshot.capture',
  label: () => '截图并放入输入框',
  aliases: ['截图', 'screenshot', 'capture screen'],
  defaults: { 'desktop:macos': { code: 'KeyS', modifiers: ['alt'] } },
  regions: ['page', 'editable'],
  modals: [],
  resolve: () => ({ status: 'handled', run: () => { void capture(); } }),
});
```

因此：

- ⌥S 会**出现在 设置 → 快捷键 的列表里**，可以改绑、可以恢复默认；
- 注册时检查 id 重复与默认键冲突；冲突会直接抛错，不会静默叠加；
- 在 macOS / Windows 桌面端，原生键盘桥在本地处理器**之前**派发绑定键，
  Option+S 不会把 `ß` 打进草稿，弹窗开着时也照样生效（桌面端优先于 modal）；
- 只声明了 `desktop:macos` 的默认值：Web 版没有 Host 的 GUI 会话，注册了也没有意义，
  所以 Web 上这条命令显示为「未绑定」；
- **系统级全局热键**（别的 App 在前台也能按）插件做不到——那需要 Hammerspoon 一类
  外部工具（本机已有一条 ⌃⌥S，走「截图→剪贴板→合成 ⌘V」，与本插件无关）。

## 实现要点

- `screencapture -i -x -t png <tmp>`：`-i` 交互、`-x` 静音、显式 PNG；退出码非 0 且没有产物 = 用户取消 → 路由返回 `204`，客户端静默复位。
- 同一个 `capture()` 同时服务按钮和 ⌥S：快捷键不复制逻辑，只复用函数；两处共享一个 `captureInFlight` 互斥。
- 截图/提示状态挂在按钮组件上，但 `capture()` 不依赖组件是否挂载（快捷键在非对话页也能触发系统框选）。
- 按钮上的键帽读 `shortcuts.catalog` 的当前绑定，改绑后不会显示过期按键。
- 同一时刻只允许一次截图（并发请求返回 `409`），避免两个系统选区叠在一起。
- 临时文件写在 `mkdtemp` 出来的目录里，返回后立即删除。
- 路由复用 Host 的连接鉴权（`connection.requestRejection`），只有 DSH 页面能调。

## 已知边界

- 只能在 DSH **桌面端**用：Web 版没有 Host 进程的 GUI 会话，`screencapture` 不可用。
- ⌥S 只在 DSH 窗口是前台时生效；别的 App 里按不会触发（这不是全局热键）。要全局，得靠 Hammerspoon 那条。
- 截图期间那个 HTTP 请求会一直挂着（最长 180 秒超时），这是「等用户选完」的必然形态。
- 依赖 DSH composer 的粘贴处理器；若未来 composer 结构变化导致合成 paste 不再被接收，会退回文件 input 通道，仍不行则报「找不到输入框」。

## 回滚

```bash
# 从 profile 移除（等价于插件页面里的卸载）
dsh plugin remove @lyra_wang/dsh-screenshot
```

或直接删掉 `~/.dsh/profiles/desktop/package.json` 里对应的依赖与 `dsh.profile.bundles` 条目，然后重启 DSH。
