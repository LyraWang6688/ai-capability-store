# investdesk-daily-context

`investdesk-portfolio` 做持仓分析时的**当日上下文**：大盘快照 + 持仓相关新闻。

确定性取数，不判断、不点评——判断留给 skill。

## 跑什么

```bash
export WIND_API_KEY=<万得 key>
export INVESTDESK_BASE_TOKEN=<飞书 Base token>
export INVESTDESK_HOLDINGS_TABLE=<「最新持仓」表 id>

python3 collect.py --no-news --dry-run       # 只取大盘，零新闻积分
python3 collect.py --top-n 15 --news-per 3 --out /tmp/ctx.json
```

输出 JSON：`trade_date` / `market[]` / `holdings_news[]` / `credits`（本次消耗的万得调用次数）。

## 数据链路（直连，不依赖本机 skill）

```
index_data.get_index_price_indicators   → 大盘 6 个指数
financial_docs.get_financial_news       → 每只持仓近一月新闻
飞书「最新持仓」（lark-cli）              → 按市值取前 N 只
```

万得走 **MCP over HTTP**（`POST https://mcp.wind.com.cn/vserver_<domain>/mcp/`，
`Authorization: Bearer`，先 `initialize` 再 `tools/call`，响应可能是 SSE）。
和 `procedures/quote-sync` 的做法一致，因此不需要在本机安装万得 skill。

## 口径与纪律

| 项 | 规则 |
|---|---|
| 大盘指数 | 上证 / 深证成指 / 创业板指 / 沪深300 / 科创50 / 恒生（`--indices` 可改） |
| 交易日 | 直接取万得返回的 `最新交易日`，**不用系统日期** |
| 成交额 | 万得返回单位是**元**，展示时转亿 |
| 持仓范围 | 只看 `持有数量 > 0` 的标的，按 `最新市值` 取前 N（默认 15，覆盖约 61% 市值） |
| 新闻过滤 | 研报/评级/目标价/深度分析/观点类一律丢弃；标题无事件词的丢弃 |
| 新闻要素 | 每条必须有标题 + 日期 + 来源链接；缺链接的不进结果 |

## 成本

每跑一次 = 1 次大盘调用 + N 次新闻调用（默认 15 → 16 次）。
万得每日免费额度 1000，够跑几十次。

## 已知边界

- 场外基金/ETF 没有公司新闻，新闻为空是正常的，不要当成失败
- 新闻相关性与事件词强相关；不同检索词召回差异很大（见 investdesk-funding-news/README）
- 大盘不含涨跌家数（万得指数接口没有该字段）
