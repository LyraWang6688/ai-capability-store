# selection-toolbar

DSH（DeepSeek Harness）桌面端插件：在对话里用鼠标划选文字后，浮出一个小工具条。

## 能力

| 动作 | 行为 |
|---|---|
| 复制 | 把选中文字写入剪贴板 |
| 追问 | 把选中文字插入 DSH 的输入框（不自动发送） |
| 注释 | 把「原文引用 + 注释 + 北京时间」追加到指定飞书文档末尾；同时在本机 localStorage 留一份离线副本 |

## 前置条件

- DSH 桌面端（提供 `shell.overlay` 槽位与插件安装）
- 本机已安装并授权 `lark-cli`（用户身份），用于写飞书文档
- 一个飞书文档（docx）的 token

## 安装

1. 把本目录放到任意本地路径，在 DSH 里安装它：
   - 插件页 → 添加插件 → 选择本目录；或
   - `plugin_manager` 以本地目录安装（`install_bundle`）
2. 创建操作者配置文件（**不要放进仓库**）：

   ```json
   // ~/.dsh/selection-toolbar.json  (chmod 600)
   { "docToken": "<飞书文档 token>", "larkCli": "/usr/local/bin/lark-cli" }
   ```

   可用环境变量 `DSH_SELECTION_TOOLBAR_CONFIG` 指向别的路径。
3. 重启 DSH；在对话里划选文字即可看到工具条。

## 验证

- `GET /plugins/selection-toolbar/note` → `405`（路由已加载；非 POST 被拒绝）
- 划选文字 → 注释 → 保存 → DSH 提示「已写入飞书文档」，目标文档 `revision_id` +1 且末尾出现该条

2026-10-19 实测环境：DSH 0.2.1-rc.2 + lark-cli 1.0.97。证据：路由 `GET` 返回 405；文档 `revision_id` 5 → 6 → 7 各追加一条；时间戳格式修正后显示为 `时间：2026/10/19 02:11`。

## 已知限制

- 只在 DSH 客户端内注入，不是通用浏览器扩展；
- 依赖本机 `lark-cli` 的已授权 profile；未配置 `docToken` 时注释只写本地，并在界面回显原因；
- 追加目标固定为配置里的那一篇文档，暂不支持按日期分文档；
- `package.json` 的 `name` 同时是 DSH 的插件 id（当前为开发期的 `@local/selection-toolbar`），改名需同步改 `client.js` 的 loader id 并重装。

## 代码结构

| 文件 | 说明 |
|---|---|
| `index.js` | Host half：注册 `POST /plugins/selection-toolbar/note`，调 `lark-cli docs +update --command append` |
| `client.js` | Client half：注册 `shell.overlay` 条目，渲染工具条与注释编辑器 |
| `cordis.patch.yml` | 插件行声明 |
| `locale/*.json` | 插件名称与描述 |
| `icon.svg` | 图标 |

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
