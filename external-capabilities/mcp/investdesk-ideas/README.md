# investdesk-ideas

飞书多维表格**想法池**的 MCP 服务：记录投资问答与灵感，支持按话题 / 状态 / 时间筛选，以及关键词搜索。

## 为什么单独做一个能力

| | `investdesk-quotes` | `investdesk-ideas`（本包） |
|---|---|---|
| 数据性质 | 客观：价格、净值、持仓估值 | 主观：问了什么、答了什么、我的判断 |
| 写入频率 | 每天两次定时 | 每次对话 |
| Schema 稳定性 | 稳定 | 会反复演进 |

行情和想法放在同一个能力里，想法池改字段会拖累行情版本。所以**按领域拆开**，各自演进。

## 工具

| Tool | 作用 | 读/写 |
|---|---|---|
| `save_idea` | 写入问答记录或灵感 | 写 |
| `list_ideas` | 按状态 / 类型 / 话题 / 天数筛选 | 读 |
| `search_ideas` | 关键词搜索问题、回复、标的、话题 | 读 |
| `update_idea` | 更新状态（待复核 → 已采纳 / 已忽略） | 写 |

## 目标表结构

飞书多维表格「想法池」，字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `问题` | text | 主字段，用户原话或灵感内容 |
| `助手回复` | text | AI 的回答（问答场景） |
| `时间` | datetime | 记录时间戳（毫秒） |
| `类型` | select | 问答 / 灵感 / 复盘 |
| `状态` | select | 待复核 / 已采纳 / 已忽略 |
| `话题` | select（多选） | AI / 人口老龄化 / 红利 / 其他 |
| `涉及标的` | text | 逗号分隔的代码 |
| `消息ID` | text | 飞书消息 ID，用于防重复 |

## 配置

凭证统一放在 `~/.investdesk/.env`（或 `INVESTDESK_HOME` 指向的目录）：

```dotenv
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
INVESTDESK_BASE_TOKEN=...
INVESTDESK_IDEAS_TABLE=...
```

需要飞书自建应用开通 `bitable:app`，并加为该 Base 的协作者（可编辑）。

## 运行

```bash
npm install
npm run build
node dist/mcp/stdio.js      # stdio 传输，MCP 宿主 spawn
```

宿主配置：

```json
{
  "mcpServers": {
    "investdesk-ideas": {
      "command": "npx",
      "args": ["-y", "investdesk-ideas"]
    }
  }
}
```

## 已知限制

- **排序**：飞书的 `sort` 参数实测报 `InvalidSort`，改为取回后在内存按「时间」倒序（池子规模小，无性能问题）
- **搜索**：飞书不支持下推全文检索，`search_ideas` 拉最近 200 条本地过滤；数据量大了要改成服务端分页聚合
- **只有 stdio 传输**：没有 HTTP 服务器，需要 HTTP 客户端（如豆包工作连接器）时要再加
