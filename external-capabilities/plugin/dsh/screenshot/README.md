# @lyra_wang/dsh-screenshot

输入框左侧多一个「＋ 截图」按钮：按下 → 系统框选屏幕（空格可切换成「选窗口」）→ 截好的图**直接作为附件进入草稿**，不用剪贴板、不用切 App。

对齐豆包工作 / Codex 的「应用截图」用法，但走的是 DSH 自己的附件管线。

## 为什么是 Host + Client 两半

| 半边 | 干什么 | 为什么不能放在一起 |
|---|---|---|
| Host (`index.js`) | 注册 `POST /plugins/screenshot/capture`，调 macOS `screencapture`，把 PNG 原样返回 | 浏览器页面无法打开系统截图 UI；`screencapture` 是同一 GUI 会话里的普通 CLI |
| Client (`client.js`) | 在 `conversation.input.left` 注册按钮；拿到 PNG 后交给输入框 | 草稿附件的 id 与上传状态由 composer 自己持有，插件只能把 `File` 交回给它的 intake 路径 |

Client 侧**不直接调上传 API**：`ctx.fileUpload.upload()` 只返回服务端凭据，而草稿附件需要客户端自己生成 id + 上传状态表。把图片做成 `File` 后合成一次 `paste` 事件（`ClipboardEvent` + `DataTransfer`），输入框就会走和用户手动粘贴完全相同的代码路径：上传 → 缩略图 → 可删除附件。找不到编辑器时退回「文件选择 input + change 事件」。

## 前台条件

- macOS（使用系统 `screencapture`）
- DSH Desktop 需要**屏幕录制**权限（系统设置 → 隐私与安全性 → 屏幕录制）。Host 进程实测可直接调用 `screencapture`；如果截图返回空白/失败，先检查这一项。

## 用法

1. 在对话输入框左侧点「＋ 截图」。
2. 屏幕出现框选十字：拖拽选区域；按 **空格** 切换成窗口选择；按 **Esc** 取消。
3. 松手后图片出现在草稿的附件区，和粘贴截图完全一样（可删除、可随消息发出）。

顶部会有一条短暂提示告诉你当前状态（框选中 / 已加入 / 出错原因）。

## 实现要点

- `screencapture -i -x -t png <tmp>`：`-i` 交互、`-x` 静音、显式 PNG；退出码非 0 且没有产物 = 用户取消 → 路由返回 `204`，客户端静默复位。
- 同一时刻只允许一次截图（并发请求返回 `409`），避免两个系统选区叠在一起。
- 临时文件写在 `mkdtemp` 出来的目录里，返回后立即删除。
- 路由复用 Host 的连接鉴权（`connection.requestRejection`），只有 DSH 页面能调。

## 已知边界

- 只能在 DSH **桌面端**用：Web 版没有 Host 进程的 GUI 会话，`screencapture` 不可用。
- 截图期间那个 HTTP 请求会一直挂着（最长 180 秒超时），这是「等用户选完」的必然形态。
- 依赖 DSH composer 的粘贴处理器；若未来 composer 结构变化导致合成 paste 不再被接收，会退回文件 input 通道，仍不行则报「找不到输入框」。

## 回滚

```bash
# 从 profile 移除（等价于插件页面里的卸载）
dsh plugin remove @lyra_wang/dsh-screenshot
```

或直接删掉 `~/.dsh/profiles/desktop/package.json` 里对应的依赖与 `dsh.profile.bundles` 条目，然后重启 DSH。
