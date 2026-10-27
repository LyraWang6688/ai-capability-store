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

## 配置

默认读取：

```text
~/Documents/workplace/feishu-retail-ops/docs/prototypes
```

可以在 `~/.dsh/html-annotate.json` 覆盖：

```json
{
  "root": "/absolute/path/to/html/directory"
}
```

也可以用环境变量 `HTML_ANNOTATE_ROOT`。

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
