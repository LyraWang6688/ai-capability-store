# @lyra_wang/dsh-selection-toolbar

DSH（DeepSeek Harness）客户端插件：在对话里用鼠标划选文字后，浮出一个工具条。

## 能力

| 动作 | 行为 |
|---|---|
| 复制 | 把选中文字写入剪贴板 |
| 追问 | 把选中文字插入 DSH 的输入框（不自动发送） |
| 注释 | 把「原文引用 + 注释 + 北京时间」追加到指定飞书文档末尾；同时在本机 localStorage 留一份离线副本 |

## 前置条件

- DSH 桌面端（提供 `shell.overlay` 槽位与插件安装能力）
- 本机已安装并授权 `lark-cli`（用户身份），用于写飞书文档
- 一个飞书文档（docx）的 token

## 安装

**从 npm 安装（推荐）**

在 DSH 插件页 →「添加插件」→ 输入包名：

```text
@lyra_wang/dsh-selection-toolbar
```

或使用命令行 `dsh plugin add @lyra_wang/dsh-selection-toolbar`。

**从本地目录安装**

插件页 → 添加插件 → 选择本目录；或 `plugin_manager` 的 `install_bundle` 指向本目录。

## 配置（仓库外，勿提交）

```jsonc
// ~/.dsh/selection-toolbar.json   (chmod 600)
{
  "docToken": "<飞书文档 token>",
  "larkCli": "/usr/local/bin/lark-cli"   // 可选，默认用 PATH 中的 lark-cli
}
```

可用环境变量 `DSH_SELECTION_TOOLBAR_CONFIG` 指向别的配置文件路径。

> 文档 token 与 CLI 路径**不放进代码仓库**；插件每次写入时读取该配置文件。

## 验证

- 重启 DSH，划选文字 → 应出现工具条；
- 点「复制」→ 出现「已复制」；
- 点「注释」→ 写备注 → 保存 → 出现「已写入飞书文档」，目标文档末尾多一条。

开发者自检：`GET /plugins/selection-toolbar/note` → `405`（路由已加载，非 POST 被拒绝）。

## 已知限制

- 只在 DSH 客户端内注入，不是通用浏览器扩展；
- 依赖本机 `lark-cli` 的已授权 profile；未配置 `docToken` 时注释只写本地，并在界面回显原因；
- 追加目标固定为配置里的那一篇文档，暂不支持按日期分文档。

## 许可证

MIT
