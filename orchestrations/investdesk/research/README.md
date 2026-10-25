# investdesk / research — 持仓调查（找标的）

人问「AI 算力有哪些 ETF」「XX 主题有什么值得看的」时走这条。

## 步骤

| 步 | 引用 | 产出 |
|---|---|---|
| 1-research | `skills/investdesk-research` | 可落库的结构化候选清单 |

**为什么没有 procedure**：它刻意不自己抓数据——行情同步归 `procedures/quote-sync`，
数据查询交给成熟插件。所以这条只有判断，没有确定性实现。

## 与 portfolio 的分工

| | portfolio | research |
|---|---|---|
| 输入 | 已有的持仓 | 一个主题 |
| 回答 | 现在怎么样 | 该看什么 |
| 边界 | 不给买卖建议 | 只给候选，不替人决策 |
