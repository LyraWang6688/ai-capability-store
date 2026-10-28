# @lyra_wang/dsh-html-annotate

在 DSH 里直接给本地 HTML 原型做批注，并把批注作为一条消息发给当前会话的 Agent；Agent 按批注改源码。

## 它解决什么

现在的 HTML 原型评审通常是：

```text
打开 HTML → 截图/复制文字 → 在对话里描述位置 → Agent 猜是哪一块
```

这个插件把链路缩短为：

```text
打开 HTML → 点元素 → 写意见 → 保存并提交 → Agent 收到结构化批注
```

插件不修改源码，只把批注写到与 HTML 同目录的 sidecar JSON；源码由 Agent 修改。

## 使用

插件**不再提供 DSH 批注面板**；`open_html_annotate` 总是用 Google Chrome 打开标注页。页面内可连续保存多条批注，最后点「提交批注」一次性发送。

用户对 Agent 说“看一下这个页面”后，Agent 调用 `open_html_annotate` 工具；插件优先从工具上下文取当前会话，只有该会话会弹出，不再使用全局广播。收到请求后启动/连接本地预览并弹出批注面板。随后：

1. 点页面里的「批注」
2. 点要改的元素，写意见，点「保存批注」；可连续保存多条
3. 全部标完后点「提交批注」，插件把这一批批注一次性发给当前会话

批注文件：

```text
<原 HTML>.annotations.json
```

## 本地预览 URL

工作台这类需要本地服务/登录态的页面，用文件模式会卡在登录检查。

在面板顶部的输入框填本地预览地址：

```text
http://127.0.0.1:5054/workbench
```

插件会：

```text
Host 代理本地页面
→ 注入批注脚本
→ 页面里的 root-relative 资源/接口按本地服务器解析
```

本地服务建议无鉴权启动：

```bash
PORT=5054 LARK_WEB_AUTH_ENABLED=false ENABLE_CORS=true node src/app.js
```

批注仍然只改本地源码；部署是单独动作。

## 只支持本地预览 URL

插件不选择文件、不扫描目录；批注对象是**本地运行中的页面**。

在面板顶部填写：

```text
http://127.0.0.1:5054/workbench
```

Host 会代理这个本地页面、注入批注脚本。

本地服务建议无鉴权启动：

```bash
PORT=5054 LARK_WEB_AUTH_ENABLED=false ENABLE_CORS=true node src/app.js
```

## 项目预览配置（自动打开）

项目根目录放：

```text
.dsh/html-annotate.json
```

```json
{
  "previewUrl": "http://127.0.0.1:5055/replenish-board-2026-10-27.html",
  "autoOpen": false,
  "previewCommand": {
    "cwd": "docs/prototypes",
    "command": ["/usr/bin/python3", "-m", "http.server", "5055", "--bind", "127.0.0.1"],
    "readyTimeoutMs": 15000
  }
}
```

插件会读取当前会话 cwd 下的这份配置。默认**启动时不自动弹窗**；只有用户说“看一下页面”时，Agent 调用 `open_html_annotate` 工具，插件才弹出并加载页面。若本地服务未运行，配置里有 `previewCommand` 时插件会自己启动它并等待就绪。

每个会话仍会用 localStorage 记住 URL。批注只改本地源码，部署是单独动作。

## 安全边界

- 只服务配置根目录下的 `*.html`
- 只写同目录的 `.annotations.json`
- 不修改原 HTML
- 不上传页面内容到外部网络
- Host 半只注册本机 DSH 路由

## 安装（开发）

```bash
dsh plugin --profile <profile> add /absolute/path/to/html-annotate
```

正式分发需要按 Store 规则发布到 npm，再从 npm 安装；本地路径只用于开发验证。

## 已知限制

- 当前批注以 overlay 面板呈现，不直接替换右侧栏 HTML 预览（第三方拿不到 `sidebarRight`）
- 需要 DSH 桌面端 / web profile
- 只处理本地可读的 HTML；公网页面需先在本地有源码

### direct: true 的换页边界（待观察）

项目配置 `direct: true` 时，iframe 直接加载目标站（例如工作台 `http://127.0.0.1:3000/workbench/`），
父窗口与目标站不同源，无法在每次整页跳转后重新注入 `annotation.js`。

- 如果页面是单页应用、只做 tab 切换，批注按钮通常保持挂载；
- 如果页面发生真正的整页跳转（点击 `<a>`、表单提交、`location.href`），新文档不会再带批注脚本，按钮会消失。

非 `direct` 模式已通过 `/plugins/html-annotate/preview` 代理并拦截同源链接，换页后会重新注入。
`direct: true` 页面若要支持整页跳转，需要在预览服务侧做反向代理注入，或让页面自行引入
`annotation.js`。当前作为待观察事项记录，未在 0.4.1 中自动修复。

## Chrome 模式（0.5.0）

项目配置 `.dsh/html-annotate.json` 增加：

```json
{
  "previewUrl": "http://127.0.0.1:3000/workbench/sales-delivery.html",
  "split": true
}
```

`open_html_annotate` 会：

1. 注册本地预览 token；
2. 用 Google Chrome 打开 `/plugins/html-annotate/preview?pid=...`；
3. 若配置 `split: true`，尝试调用本机 Hammerspoon `_G.splitDSHChrome()` 做左 DSH / 右 Chrome 五五分屏；
4. Chrome 顶层提交的批注会进入服务器 pending 队列，由 DSH 客户端轮询后注入当前会话（不再依赖父窗口 postMessage）。

边界：

- macOS + Google Chrome；分屏依赖本机 Hammerspoon 模块（没有则只打开 Chrome，不报错）；
- 没有 DSH 面板兜底，所有标注统一走 Google Chrome；
- Chrome 提交必须走插件预览页（`/plugins/html-annotate/preview?...`），不能直接打开原始 HTML；
- 最终会话注入仍依赖 DSH 客户端轮询；客户端需在 0.5.0 重新加载。


## 0.6.0：Chrome only

面板模式已删除，不再有 `browser: "panel"` 兜底。DSH 客户端只保留一个零 UI 的 pending 轮询器，把 Chrome 提交的批注注入当前会话。
