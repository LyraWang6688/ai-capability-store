# investdesk-ideas

飞书多维表格「灵感记录 + 备选池」的 MCP 服务：记录你让 AI 推荐过的股票/ETF，累计提及次数，并双向关联回每次提问。

## 解决什么问题

我问「AI 算力里有哪些 ETF 值得看」，AI 推了 515880、159819。
下次又问「算力还有什么标的」，AI 又推 515880。

- 想知道**哪些标的被反复推荐**（可能真的值得关注）
- 想知道**每个标的当初是因为什么被推的**
- 想反查**某次提问推了哪些标的**

所以不是「对话日志」，是**标的沉淀 + 追问溯源**。

## 数据模型

```
灵感记录（我问了什么 / AI 答了什么）
    ↕ 双向关联
备选池（每个标的：提及次数 / 首次 / 最近 / 状态 / 推荐理由）
```

**灵感记录**

| 字段 | 类型 | 说明 |
|---|---|---|
| `问题` | text | 主字段，用户原话 |
| `时间` | datetime | |
| `话题` | multi-select | AI / 人口老龄化 / 红利 / 其他 |
| `助手回复` | text | 完整回答 |
| `推荐标的` | link → 备选池 | 双向关联 |

**备选池**

| 字段 | 类型 | 说明 |
|---|---|---|
| `代码` | text | 主字段，6 位 |
| `名称` | text | |
| `资产类型` | select | 股票 / ETF / LOF / REIT / 场外基金 / 其他 |
| `提及次数` | number | 每被推荐一次 +1 |
| `首次提及` / `最近提及` | datetime | |
| `状态` | select | 观察中 / 已买入 / 已忽略 |
| `推荐理由` | text | 多次推荐时追加，最近一条在末尾 |
| `关联灵感` | link → 灵感记录 | 自动生成的反向关联 |

## 工具

| Tool | 作用 |
|---|---|
| `save_recommendation` | 记录一次推荐：写灵感记录 + upsert 备选池（次数+1、更新最近提及、追加理由）+ 双向关联 |
| `list_watchlist` | 查看备选池，按提及次数排序 |
| `search_inspirations` | 搜索历史提问与回答 |
| `update_watchlist` | 改标的状态（观察中 / 已买入 / 已忽略） |

## 配置

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
INVESTDESK_BASE_TOKEN=
INVESTDESK_IDEAS_TABLE=      # 灵感记录表
INVESTDESK_WATCH_TABLE=      # 备选池表
```

凭证放在 `~/.investdesk/.env`（或 `INVESTDESK_HOME` 指向的目录）。

## 运行

```bash
npm install
npm run build
node dist/mcp/stdio.js
```

## 实测踩到的三个飞书 API 坑

1. **`GET /records` 的 `filter` 参数不被识别**，会报 `InvalidFilter`。必须改用 `POST /records/search`，把 filter 放在 body 里。
2. **`sort` 参数报 `InvalidSort`**。改为取回后在内存排序。
3. **读回来的日期是 ISO 字符串**（写入时是毫秒数）。直接用 `Number()` 转换会得到 `NaN`，排序和格式化全错——必须用 `Date.parse`。

## 已知限制

- 只有 stdio 传输，没有 HTTP（需要豆包工作直连时要再加）
- 无全文检索：`search_inspirations` 拉最近 200 条在本地过滤
- `提及次数` 是机器人维护的数字，不是公式；绕过 MCP 手工改数据不会自动重算
