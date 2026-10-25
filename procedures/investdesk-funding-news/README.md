# investdesk-funding-news

把 Wind 财经新闻里的**投融资事件**采到飞书「投融资事件」表（`王颖的财富管理` Base）。

MVP 阶段：固定 4 家公司（腾讯控股 / 阿里巴巴 / 字节跳动 / DeepSeek）。

## 跑什么

```bash
export INVESTDESK_BASE_TOKEN=<飞书 Base token>   # 目标 Base（不入库）
node --version                       # 需要 node >= 20（技能 CLI 依赖）
python3 collect.py --dry-run         # 只取数、分类、打印，不写库
python3 collect.py                   # 写入飞书
python3 collect.py --top-k 10        # 每家公司取更多条
```

输出 JSON：`fetched / kept / dropped_noise / to_create / created`。

## 数据链路

```
关键词组 → node ~/.agents/skills/wind-mcp-skill/scripts/cli.mjs
                 call financial_docs get_financial_news
         → 事件判定/分类/金额抽取（纯逻辑，见 collect.py 顶部规则）
         → 按「来源链接」去重 → 写入飞书表
```

## 三条纪律（写死在代码里）

1. **金额只记录原文**：`100亿` / `1000亿元` / `150亿美元` 各按原样存，不换算、不合并、不推断币种
2. **只采集，不做投资建议**
3. **每条必须带来源链接 + 可信度分级**（官方公告 / 主流财经 / 一般财经 / 自媒体）

## 噪音过滤

研报、评级、债券、业绩点评、人物访谈一律丢弃（`NOISE_RE`），标题是疑问句的也丢弃（`QUESTION_RE`）。

## 已知局限（MVP 明确不解决）

| 局限 | 说明 |
|---|---|
| **同一事件不聚合** | DeepSeek 那轮融资有 4 篇报道 → 表里 4 行。聚合需要判断"是不是同一件事"，属于下一步 |
| **可信度靠关键词** | 正文没写来源时一律判"自媒体"，会低估 |
| **只覆盖 4 家** | 扩到全部持仓需要先有"持仓标的 → 检索词"的映射 |
| **未上市公司无官方口径** | 字节/DeepSeek 只有媒体说法，金额/估值会互相矛盾（原文并存即为此设计） |
| **港股/美股公告查不到** | `get_company_announcements` 的语料是 A 股，腾讯/阿里要走新闻通道 |

## 下一步

1. 同一事件聚合（按 公司 + 事件类型 + 金额 归并，保留多来源）
2. 扩到持仓全标的（读「最新持仓」表 → 生成检索词）
3. 把"可信度"从关键词升级为「来源域名白名单」
