# @lyra_wang/dsh-selection-toolbar

DSH（DeepSeek Harness）客户端插件：在对话里用鼠标划选文字后，浮出一个工具条。

## 能力

| 动作 | 行为 |
|---|---|
| 复制 | 把选中文字写入剪贴板 |
| 追问 | 不直接发送：先浮出引用条（可 ✕ 关闭），回车/点发送时才把 `> 选中文字` 插进草稿一起发出；不弹提示 |
| 收藏 | 选中文字 → 浮出小面板写一句自己的话（**可留空**）→ 把「原文引用 + 备注 + 北京时间」追加到配置的飞书文档末尾；**不留本地副本**，写失败时面板留在原地可直接重试 |
| 投递 | 按 `context-submit` 规范结构化后写入飞书「投递箱」Base（见 0.4.0 段） |
| 收录 | 把选中原文投递给会话里的 agent，由 `repo-collector` 技能写「GitHub 优质项目收录」表（插件自己不写表） |
| 快捷键 | 把选中文字追加到 `~/.command-sync/shortcuts.md`（command-sync 面板的数据源） |
| **改写** | 选中一段文字 → 说怎么改（润色 / 更简洁 / 小红书风 / 公众号风 / 自定义）→ 只重写这一段，可复制或插入输入框 |

## 前置条件

- DSH 桌面端（提供 `shell.overlay` 槽位与插件安装能力）
- 本机已安装并授权 `lark-cli`（用户身份），用于写飞书文档
- 一个飞书文档（docx）的 token（只用「收藏」时需要）
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

**每个使用者配置自己的**，没有任何默认值会指向别人的飞书资源：

```jsonc
// ~/.dsh/selection-toolbar.json   (chmod 600)
{
  // 「收藏」必需：你自己的飞书云文档（docx）token
  "docToken": "<你自己文档的 token>",

  // 「投递」必需：你自己的「投递箱」多维表格
  "baseToken": "<Base token>",
  "tableId": "<table id>",

  // 以下均可选
  "skillDir": "~/Documents/workplace/ai-capability-store/skills/context-submit", // 投递门禁脚本所在 skill
  "defaultProject": "DSH 选区投递",          // 投递时来源项目留空则用它
  "larkCli": "/usr/local/bin/lark-cli",      // 默认用 PATH 里的 lark-cli
  "rewriteModel": "deepseek-flash",          // 「改写」用的模型
  "rewriteBaseUrl": "https://api.deepseek.com",
  "keychainService": "DEEPSEEK_API_KEY"      // 从钥匙串取改写 key 的条目名
}
```

可用环境变量 `DSH_SELECTION_TOOLBAR_CONFIG` 指向别的配置文件路径。

> **包里不带任何个人资源**：docToken / baseToken / tableId 全部来自这份仓库外配置。
> 只装插件、不建配置时：「收藏」会提示「未配置飞书文档：请在 … 写入 {"docToken":…}」，
> 「投递」会提示「未配置投递箱」——**不会**写到作者的表或文档里。
> 另外需要使用者本机自己的 `lark-cli` 登录态（用户身份），它只对使用者有权限的资源生效。

## 验证

- 重启 DSH，划选文字 → 应出现工具条；
- 点「复制」→ 出现「已复制」；
- 点「收藏」→ 写备注（可留空）→ 保存 → 出现「已收藏到飞书文档」，目标文档末尾多一条；
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

## 0.9.7：追问不再弹 toast；README 补全按钮

1. **「追问」不再弹「已插入输入框」** —— 引用条本身就是反馈，再弹一句是噪音。行为不变：仍不自动发送，回车/点发送时才把 `> 选中文字` 插进草稿。
2. **「收藏」只写飞书文档，不写本地 localStorage** —— 代码原本就是这样（本地副本只有「注释」才有，作为飞书写失败时的兜底）。本次把 README 能力表补全，并写明**收藏与注释写的是同一篇飞书文档**（同一个 `docToken`，收藏的 `note` 为空）。
3. README 能力表补上 **收藏 / 投递 / 收录 / 快捷键** 四行，此前只列了复制/追问/注释/改写。

## 0.10.0：收藏 = 带备注的收藏（合并了「注释」）

上一版之后暴露的真问题：**「注释」面板写了但没入口**（0.4.0 起旧的收藏改成不带备注，注释的 action 被摘掉，面板成了孤儿），而「收藏」又不让人写自己的话。

现在合成一个动作：

1. 点 **☆ 收藏** → 浮出小面板，写一句自己的话（**可留空**，留空就等于只存原文引用）；
2. 保存 → 「原文引用 + **备注** + 北京时间」追加到配置的飞书文档末尾；
3. **不再留 localStorage 副本**（0.9.7 的兜底逻辑删掉）：写失败时面板不关、直接提示原因，原地重试；
4. 独立的「注释」入口与旧的「不带备注的收藏」一并移除。

> token / 表格都是**使用者自己的**：`docToken` 写自己的文档、`baseToken`+`tableId` 写自己的投递箱，全部在仓库外的 `~/.dsh/selection-toolbar.json`。包内不含任何个人飞书资源，未配置时接口会明确报错，不会写到作者的表或文档里。
