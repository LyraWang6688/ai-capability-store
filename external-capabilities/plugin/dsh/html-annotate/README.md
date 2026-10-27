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

## 自动扫描当前会话工作区

插件按当前 DSH 会话记录的工作目录自动扫描 HTML：

```text
<session cwd>/**/*.html
```

自动忽略 `node_modules`、`.git`、`dist`、`build`、`coverage` 等目录。每个会话记住上次选择的页面。

不需要手动配置页面；切换会话到另一个项目时，插件会读那个项目的工作区。

如果会话日志里没有 cwd，才回退到 `~/.dsh/html-annotate.json` 的 `root` 或环境变量 `HTML_ANNOTATE_ROOT`。

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
