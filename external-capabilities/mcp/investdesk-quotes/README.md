# investdesk-quotes

A 股与场外公募基金行情查询 + 飞书多维表格持仓读写的 MCP 服务。

个人投资组合的「事实层」：把持仓的数量、成本、最新价格、市值维护在一张飞书多维表格里，
对外只暴露三个工具——查行情、看组合、刷价格。

## 为什么需要它

券商 App 和基金销售平台各自只能看到自己那一份持仓，跨平台的总账、成本、收益没有统一口径。
这个能力把散落在多个平台的持仓汇到一张表里，每日自动刷新价格，让「我现在到底有多少、赚了多少」
成为一个随时可查的数字，而不是每次手工加总。

## 工具

| Tool | 作用 | 读写 |
|---|---|---|
| `lookup_quotes` | 查场内标的（个股 / ETF / LOF / REITs）价格，或场外公募基金净值 | 读 |
| `portfolio_overview` | 读飞书持仓表，按平台汇总市值 / 成本 / 盈亏，列出市值最大的 N 只 | 读 |
| `sync_prices` | 抓取全部持仓最新价格并写回飞书表格 | 写 |

## 数据源

| 资产 | 来源 | 说明 |
|---|---|---|
| 个股 / ETF / LOF / REITs | 腾讯行情 `qt.gtimg.cn` | 免费、免认证、批量查询、GBK 编码 |
| 场外公募基金 | 东方财富基金历史净值 | 免费、免认证；QDII 净值晚 T+1 / T+2 |

两条都是公开网页接口，**没有授权模型，也没有 SLA**。限频、改版、字段变更都可能导致取价失败，
因此实现里做了：批量请求、失败重试、多轮去重，并且**抓不到就保持原值，绝不写 0**。

## 一个必须知道的坑：代码会撞

同一个 6 位数字可能既是股票又是场外基金。例如 `000866`：

- 深市有一只已退市的「扬子石化」
- 场外有一只「华宝制造股票」

只按代码猜类型，会把退市股票的僵尸报价当成你的基金价格。所以取价路由由**表格里的
「定价方式」字段**决定（`场内行情` / `场外净值` / `手工录入`），不靠代码规则推断。
手工调用 `lookup_quotes` 查场外基金时，必须显式传 `route: "场外净值"`。

## 认证

两层，都不经过 MCP 参数：

1. **客户端 → MCP**：无认证，绑定 `127.0.0.1`，仅供本机客户端使用
2. **MCP → 飞书**：复用部署机上已认证的 `lark-cli` profile，凭据存在 lark-cli 自己的凭据库里

行情接口免认证。

## 配置

工作目录默认 `~/.investdesk`，可用 `INVESTDESK_HOME` 覆盖。**代码在 Store 检出目录，状态在工作目录**，
两者独立，所以更新代码不会碰你的凭证。

`$INVESTDESK_HOME/.env`：

```dotenv
INVESTDESK_BASE_TOKEN=...            # 飞书多维表格 base token
INVESTDESK_HOLDINGS_TABLE=...        # 持仓表 table id
INVESTDESK_PLATFORMS_TABLE=...       # 平台表 table id
MCP_PORT=8787                        # 可选
```

`.cache/` 与 `inbox/` 会自动创建，用于存放 lark-cli 的中间产物和邮件附件。

## 运行

```bash
npm run mcp          # Streamable HTTP，http://127.0.0.1:8787/mcp
npm run mcp:stdio    # stdio 模式
npm run quote -- 510300 600028          # 手动查场内
npm run quote -- f:008284               # 手动查场外（f: 前缀）
```

**源码是 TypeScript，但发布到 npm 的是编译后的 JS（`dist/`）。** 这不是洁癖：

> Node 拒绝为 `node_modules` 下的文件做类型擦除
> （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。
> 直接发布 `.ts` 在本地源码目录能跑，`npm install` 之后却起不来——
> 而 `npm pack --dry-run` 不会暴露这个问题，只有真装一次才会。

所以 `prepare` 会在发布前自动 `tsc`，`bin` 指向 `dist/`。运行时零依赖，构建期只需要 `typescript`。
本地开发仍然可以直接 `node src/mcp/server.ts`（不在 `node_modules` 下，类型擦除可用）。

## 在豆包工作中接入

`技能 · 连接器 · 伙伴` → 「新建」→「新建自定义连接器」→ 传输类型 `HTTP` →
URL 填 `http://127.0.0.1:8787/mcp` → 保存并打开开关。

## 限制

- `status: limited`：依赖本机已认证的 lark-cli profile，不是装上即用
- 只覆盖公开行情，**没有** Level-2、资金流、公告正文等付费数据
- 不做投资建议；输出只有数据口径，不产出买卖结论
