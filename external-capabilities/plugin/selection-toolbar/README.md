# @lyra_wang/dsh-selection-toolbar

DSH（DeepSeek Harness）客户端插件：在对话里用鼠标划选文字后，浮出一个工具条。

## 能力

| 动作 | 行为 |
|---|---|
| 复制 | 把选中文字写入剪贴板 |
| 追问 | 把选中文字插入 DSH 的输入框（不自动发送） |
| 注释 | 把「原文引用 + 注释 + 北京时间」追加到指定飞书文档末尾；同时在本机 localStorage 留一份离线副本 |
| **改写** | 选中一段文字 → 说怎么改（润色 / 更简洁 / 小红书风 / 公众号风 / 自定义）→ 只重写这一段，可复制或插入输入框 |

## 前置条件

- DSH 桌面端（提供 `shell.overlay` 槽位与插件安装能力）
- 本机已安装并授权 `lark-cli`（用户身份），用于写飞书文档
- 一个飞书文档（docx）的 token（只用「注释」时需要）
- 一个模型 API Key（只用「改写」时需要）：环境变量 `DEEPSEEK_API_KEY` 或系统钥匙串同名校验项

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
  "larkCli": "/usr/local/bin/lark-cli",   // 可选，默认用 PATH 中的 lark-cli
  "rewriteModel": "deepseek-flash",       // 可选，「改写」用的模型
  "rewriteBaseUrl": "https://api.deepseek.com", // 可选，OpenAI 兼容端点
  "keychainService": "DEEPSEEK_API_KEY"   // 可选，从钥匙串取 key 的条目名
}
```

可用环境变量 `DSH_SELECTION_TOOLBAR_CONFIG` 指向别的配置文件路径。

> 文档 token 与 CLI 路径**不放进代码仓库**；插件每次写入时读取该配置文件。

## 验证

- 重启 DSH，划选文字 → 应出现工具条；
- 点「复制」→ 出现「已复制」；
- 点「注释」→ 写备注 → 保存 → 出现「已写入飞书文档」，目标文档末尾多一条；
- 点「改写」→ 选风格或写要求 → 出现改写结果 → 「复制结果 / 插入输入框」。

开发者自检：`GET /plugins/selection-toolbar/note` 与 `GET /plugins/selection-toolbar/rewrite` 都应返回 `405`（路由已加载，非 POST 被拒绝）。

## 已知限制

- 只在 DSH 客户端内注入，不是通用浏览器扩展；
- 依赖本机 `lark-cli` 的已授权 profile；未配置 `docToken` 时注释只写本地，并在界面回显原因；
- 追加目标固定为配置里的那一篇文档，暂不支持按日期分文档。

## 许可证

MIT

## 0.4.0：收藏 + 投递

| 按钮 | 行为 | 依赖配置 |
|---|---|---|
| 收藏 | 把选中原文追加到飞书文档《好的内容》（不再输入注释） | `docToken` |
| 投递 | 按 `context-submit` skill 的规范结构化（类型/内容/来源项目），过门禁脚本后写入飞书「投递箱」Base | `baseToken`、`tableId`、`skillDir` |

投递链路：模型结构化 → `validate_entry.py` 门禁（FAIL 不写）→ `check_similar.py` 查重（不阻塞）→ `lark-cli base +record-batch-create` 写入（状态=待提炼）。

配置文件 `~/.dsh/selection-toolbar.json` 示例：

```json
{
  "docToken": "<好的内容 doc token>",
  "baseToken": "<Base token>",
  "tableId": "<投递箱 table id>",
  "skillDir": "~/Documents/workplace/ai-capability-store/skills/context-submit",
  "defaultProject": "DSH 选区投递"
}
```
