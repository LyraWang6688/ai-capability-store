# investdesk-market

A 股市场宽度 MCP：板块涨跌排行、个股/ETF 主力资金流、财经快讯、指数快照。
全部使用腾讯、东方财富、新浪的**公开免费接口**，无授权、无配额。

## 为什么需要它

`investdesk-quotes` 只能回答「某只标的多钱」——那是点价格。
当用户问「AI 算力里有哪些 ETF 值得看」时，模型只能凭训练记忆回答，
不知道最近的消息、板块强弱、资金流向。

这个能力补的就是「市场上下文」。

## 工具

| Tool | 数据 | 来源 |
|---|---|---|
| `sector_ranking` | 行业/概念板块涨跌排行 + 主力资金净额 | 东财（失败回退新浪） |
| `fund_flow` | 个股/ETF 最近一日主力资金流 | 东财 |
| `market_news` | 财经 7×24 快讯，可关键词过滤 | 东财 |
| `index_snapshot` | 上证/深证/创业板/科创50/沪深300/中证500 | 腾讯 |

## 数据源稳定性（实测）

| 源 | 状态 | 处理 |
|---|---|---|
| 腾讯 `qt.gtimg.cn` | 稳定 | **GBK 编码**，必须 `TextDecoder('gbk')`，否则中文乱码 |
| 东财 `newsapi` | 稳定 | 返回 JSONP，需要剥 `var ajaxResult=` |
| 东财 `push2/clist`（板块） | **不稳定**，同一 URL 时而 `RemoteDisconnected` | 3 次重试 + 多域名 + **新浪回退** |
| 东财 `stock/fflow`（资金流） | 间歇失败 | 3 次重试 |
| 新浪 `newSinaHy.php` | 稳定 | GBK，只有涨跌幅和领涨股，无资金流 |

**设计原则**：源失败就明确告诉用户「数据源不可用」或「已回退新浪」，
绝不编造数字。

## 运行

```bash
npm install
npm run build
node dist/mcp/stdio.js
```

宿主配置：

```json
{
  "mcpServers": {
    "investdesk-market": { "command": "npx", "args": ["-y", "investdesk-market"] }
  }
}
```

## 已知限制

- 只有 stdio 传输
- 板块资金流只有东财有，新浪回退时不带资金流
- ETF 规模 / 跟踪指数 / 费率**没有**稳定免费源，暂不提供
- 所有数据是 T 日收盘口径，盘中不实时
