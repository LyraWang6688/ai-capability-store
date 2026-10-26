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
- **「追问」的引用是"发送前插入"**：DSH 没有 submit 钩子，只能在按回车/点发送那一刻把
  `> 原文` 插到光标处。所以：光标要在**末尾**（点「追问」会自动把光标移到末尾，之后别再移动），
  否则引用可能丢；插入的换行会被编辑器吞掉，看起来是 `你的话> 原文` 粘在一行。
  这条限制源于宿主没有开放"发送前改写消息"的能力，插件侧无法绕过。
- 引用条是**会话内**状态：切换会话（输入框被重建）会自动清掉，不会串到别的会话。
- 引用条位置跟随输入框：输入框变高时引用条会重新贴到它上方（ResizeObserver + 轮询兜底）。

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

## 0.7.0：收录改为「纯 AI」模式

点「📦 收录」后，插件**不再写表**，而是把整件事交给当前会话的 agent：

1. 校验选中内容是 `owner/repo`（**0.9.5 起已移除**，见文末）；
2. 取最近活跃的普通会话（`sessionController.list` → 跳过 subagent）；
3. `sessionController.prompt` 投递收录任务（`queue` 模式）；
4. agent 按 `repo-collector` 技能执行：查重 → 拉 GitHub 事实 → 读 README → 写中文简介/亮点/参考价值/标签 → 门禁 → 写表 → 回读 → 一句话汇报。

边界：

- **没有活跃会话 → 明确报错，不写任何东西**（避免"点了没反应"）；
- 重复收录由 agent 的查重步骤拦下（退出码 10），不会插第二行；
- 同一时间只投递一次任务，不存在脚本与 AI 双写。

## 0.9.5：收录不再要求选中 `owner/repo`

旧行为：只取选区**第一个空白分词**，要求它严格匹配 `owner/repo`。于是选一段文章
（例如「mobile-mcp（mobile-next 出品，~10k star）」）会被直接拒绝，弹
「请选中 owner/repo 形式的仓库名」——而这时人想表达的意思明明是清楚的。

现在起：

1. **选中什么就送什么** —— 原文一字不改放进投递任务的引用块里，插件不解析、不猜；
2. 由 agent 在会话里判断是哪个仓库（它可以 `web_fetch` / 搜 GitHub；判断不唯一或指多个仓库时停下来问人）；
3. 只保留两条硬检查：不能为空、上限 2000 字符；
4. 成功提示改为「已交给 AI 收录（带上了你选中的 N 个字）」。

`repo-collector` 技能里「先确认是哪个仓库」因此成了投递任务的第 0 步。

## 0.9.6：投递模板去掉已删除的「跟进状态」

2026-10-27 用户删掉了收录表里的「跟进状态」列，`repo-collector` 的技能契约同步改成 11 个字段
（`scripts/target.json`）。投递任务的第 3 步原先写着「跟进状态默认『待深入』」，等于每次收录
都让 agent 去写一个不存在的列。

现改为「字段以技能里的 `scripts/target.json` 为准（当前 11 个字段，无『跟进状态』）」。

无功能改动：插件仍不写表、不读字段契约，只投递一段文字；改的只是这段文字的措辞。
