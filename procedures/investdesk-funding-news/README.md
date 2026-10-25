# investdesk-funding-news

把 Wind 财经新闻里的**投融资事件**采到飞书「投融资事件」表（`王颖的财富管理` Base）。

覆盖 8 家公司（写在 `GROUPS` 里，改这一处即可增删）：

| 国内 | 海外 |
|---|---|
| 腾讯控股 · 阿里巴巴 · 字节跳动 · DeepSeek | 英伟达 · 谷歌 · OpenAI · 苹果 |

**检索词很关键**：问"谷歌 投资并购"会召回财报和"如何买谷歌股票"的稿子，
必须写成「谷歌 Alphabet 收购、并购交易、投资入股」才能命中交易类新闻。已固化在代码里。

## 跑什么

```bash
# 只抓取：产出 payload，完全不碰飞书（GitHub Actions 用的就是这个模式）
export WIND_API_KEY=<万得 key>
python3 collect.py --mode fetch --out payload.json

# 只写入：把 payload 写进飞书（服务器侧执行，需要 lark-cli 已登录）
export INVESTDESK_BASE_TOKEN=<飞书 Base token>
python3 collect.py --mode write --in payload.json

# 一把梭（本机调试用）
export WIND_API_KEY=... INVESTDESK_BASE_TOKEN=...
python3 collect.py
```

`--mode fetch` **只需要万得 key**，不读也不写飞书；`--mode write` **只需要飞书凭据**，不调万得。
这个切分是为了让 GitHub Actions 只承担抓取，把飞书写入留在服务器（详见下面的调度）。

输出 JSON：`fetched / kept / dropped_noise / to_create / created`。

## 数据链路

```
关键词组 → 直连万得 MCP over HTTP（initialize + tools/call，响应可能是 SSE）
         → 事件判定/分类/金额抽取（纯逻辑，见 collect.py 顶部规则）
         → payload JSON
         → 按「来源链接」去重 → 写入飞书表
```

**不依赖本机安装的万得 skill**：万得的 `cli.mjs` 只是 JSON-RPC 薄封装，这里直接发 HTTP，
因此 GitHub Actions 的 runner 上也能跑。

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
| **只覆盖 8 家** | 扩到全部持仓需要先有"持仓标的 → 检索词"的映射；海外公司名要做中英映射 |
| **检索词决定召回质量** | 同一家换个问法，召回结果差异极大（谷歌一例：财报 vs 交易） |
| **未上市公司无官方口径** | 字节/DeepSeek 只有媒体说法，金额/估值会互相矛盾（原文并存即为此设计） |
| **港股/美股公告查不到** | `get_company_announcements` 的语料是 A 股，腾讯/阿里要走新闻通道 |

## 下一步

1. 同一事件聚合（按 公司 + 事件类型 + 金额 归并，保留多来源）
2. 扩到持仓全标的（读「最新持仓」表 → 生成检索词）
3. 把"可信度"从关键词升级为「来源域名白名单」
