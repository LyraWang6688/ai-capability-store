# investdesk-quote-sync

每个交易日两次，把全部持仓的最新价格写回飞书多维表格。

## 为什么是 automation 而不是 capability

取价和写库的能力本身在 `external-capabilities/mcp/investdesk-quotes` 里，可以被人或 Agent
随时调用。这个自动化的唯一职责是**在时钟响起时触发它**——一个是「能做什么」，一个是「什么时候做」。

入口 `sync.ts` 是薄壳，只调用能力层导出的 `syncPortfolioPrices()`。定时任务和 MCP 的
`sync_prices` 工具共用同一个函数，不存在第二份实现。

## 触发

`executor: github-actions`，周一至周五两次（北京时间）：

| 时间 | 目的 |
|---|---|
| 20:00 | 每天一次。场内收盘价已定，场外基金净值开始公布（QDII 更晚，属正常） |

具体时间只写在 `deploy/com.investdesk.quotes.plist.template` 里，registry 只记 `trigger_kind: daily`，
避免同一份 cron 存在两处而漂移。

## 输入

| 来源 | 内容 |
|---|---|
| 飞书多维表格「最新持仓」 | 每个标的的代码与「定价方式」 |
| `$INVESTDESK_HOME/.env` | 飞书 base token 与表 id |
| 腾讯行情 / 东财净值 | 公开 HTTP 接口，免认证 |

## 输出

写回飞书表格的「最新价格」字段；「最新市值」是公式字段，会自动重算。

**抓不到价格的标的不写 0**，保持原值并单独上报。这条规则来自一次真实事故：
早期版本里价格字段是文本，公式乘出来恒为 0，表格上显示的是「负成本」——一个看起来像
亏损的错误结论。

## 失败模式

| 现象 | 原因 | 处置 |
|---|---|---|
| 退出码 1 | 成功率低于 80% | 查 `.cache/quotes.err.log`，通常是数据源改版或被限频 |
| 场外取价失败 | 净值尚未公布 | 正常，次日会取到更新的净值 |
| 全部标的都是「未返回行情」 | 代码与「定价方式」不匹配 | 检查表里的「定价方式」是否填对 |

## 部署

**主执行器是 GitHub Actions**，配置在 `.github/workflows/automation-investdesk-quote-sync.yml`，
凭据走仓库 Secrets，无需任何机器开机。

本机 launchd 已停用（2026-10-18 卸载）。`deploy/` 保留为可选的本机备份方案：
需要在本机也跑一份时，用 `deploy/install.sh` 安装，两端写入幂等、互不冲突。

```bash
deploy/install.sh --dry-run     # 渲染 plist 看看
deploy/install.sh --run-now     # 安装并立刻跑一次
deploy/uninstall.sh             # 卸载（工作目录与日志保留）
```

代码在 Store 检出目录，状态（`.cache` / 日志）在工作目录，默认 `~/.investdesk`。
更新代码不会碰凭证。

## 依赖

- Node.js 22.6+（原生执行 TypeScript，无需构建）
- 飞书自建应用（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`），并已加为 Base 协作者
- `external-capabilities/mcp/investdesk-quotes`

## 与能力层的边界

这个自动化**不定义**取价规则、不定义字段映射、不做数据校验——这些都归能力层。
它只负责：什么时候跑、跑完怎么上报、失败怎么退出。
