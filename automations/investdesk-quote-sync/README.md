# investdesk-quote-sync

每个交易日两次，把全部持仓的最新价格写回飞书多维表格。

## 为什么是 automation 而不是 capability

取价和写库的实现在本目录的 `src/` 下，自包含（不依赖外部能力包）。原先共用的
MCP 能力包 `investdesk-quotes` 已按架构调整移除——那个 MCP 形态是给自建机器人用的，
机器人的职责已经交给豆包工作。
随时调用。这个自动化的唯一职责是**在时钟响起时触发它**——一个是「能做什么」，一个是「什么时候做」。

入口 `sync.ts` 只做调度与日志，取价逻辑调用 `src/portfolio.ts` 的 `syncPortfolioPrices()`。原先定时任务和 MCP 的
`sync_prices` 工具共用同一个函数，不存在第二份实现。

## 触发

`executor: github-actions`，`trigger_kind: daily`，weekday 20:00（北京时间）。

**但钟不在 GitHub 上。** GitHub 的 `schedule` 在本仓库实测延迟 4-5 小时（workflow 里原来
记着 "QUEUED FOR 4h14m"），而这个任务必须赶在次日 09:00 的消费方之前落地。所以：

```text
自建服务器 crontab（准点 20:00）
   → POST /actions/workflows/automation-investdesk-quote-sync.yml/dispatches
   → GitHub 立刻创建 run（手动触发的 run 不走调度队列）
   → 在 GitHub 的 runner 上执行（凭据仍是 GitHub Secrets）
```

```text
工作流里       只有 workflow_dispatch（schedule 已移除）
registry       外部钟由 external_trigger 指向下面那个 cron 描述
准点来源       deploy/server-trigger.cron（{{HOUR}} 按服务器时区换算）
安装与运维     deploy/SERVER-TRIGGER.md
```

**代价：没有兜底。** 服务器挂了或令牌过期，当天就不跑。要把保险加回来，在 workflow 里加一段
低频 `schedule`（例如每周一次）即可 —— 它只会重复一次幂等写入。

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
- `automations/investdesk-quote-sync/src/`（取价与写库，自包含）

## 与能力层的边界

这个自动化**不定义**取价规则、不定义字段映射、不做数据校验——这些都归能力层。
它只负责：什么时候跑、跑完怎么上报、失败怎么退出。
