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

1. 在 DSH 输入框左侧点「📝 HTML 批注」
2. 选择要批注的 HTML
3. 点页面里的「批注」
4. 点要改的元素，写意见，点「保存并提交」
5. 插件把这一批批注发给当前会话

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
