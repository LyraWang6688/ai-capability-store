# frontier-watch

每周一 10:00（Asia/Shanghai）抓取三个前沿工具的新功能，**提取成结构化条目写进飞书 Base**，
供"把好用的功能做成 DSH 插件"这条线取材。

- **Codex**：GitHub `openai/codex` Releases（有完整 Release Notes）
- **Claude**：`support.claude.com` 发布说明页
- **豆包工作**：没有公开 changelog、公众号也抓不了 → 用**公开报道**兜底（Google News / Bing News 的 RSS 搜索，CI runner 在海外可访问；两个源互为备份，失败即跳过）

## 为什么是 Automation，不是 Skill

`PUBLISHING.md` §C 的问题是：**谁决定它什么时候跑？**
这里没有"谁"——周一 10:00 的时钟决定。它只做采集与结构化，不产出结论、不动仓库。

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 抓取发布说明原文 | 不替你判断"该不该做这个插件" |
| 调模型提取「功能名 / 说明 / 可否做成 DSH 插件 / 难度 / 优先级」 | 不自动开发插件、不改任何仓库 |
| 按功能名去重后写入 Base | 不删除/覆盖已有记录 |

## 触发与执行器

- `trigger_kind: weekly`，cron 只写在 `.github/workflows/automation-frontier-watch.yml`（周一 10:00 北京时间）
- `executor: github-actions`：走飞书**应用身份** `tenant_access_token`，不读本机钥匙串、不需要 lark-cli，
  Mac 关机也照跑
- 手动验证：Actions → automation-frontier-watch → Run workflow（`dry-run` 默认 true，只打印不写）

### 需要的 secrets

| Secret | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 与 `github-portfolio-snapshot` 共用同一个飞书自建应用 |
| `DEEPSEEK_API_KEY` | 提取功能用的模型 Key |
| `FRONTIER_CONFIG_JSON` | `{"base_token":"…","table_id":"…","model":"deepseek-flash"}` |

飞书控制台还要做两件事（脚本做不了）：给应用授予 `base:record:read` / `base:record:create` /
`base:field:read` 等 scope 并发布版本；把该应用加为目标 Base 的**可编辑协作者**。

### 在本会话里看结果（和 github-trending 一样）

CI 只负责采集与写入；**每周的汇报由本机 DSH 定时任务完成**（它读 Base，不需要任何飞书 Secret）：

```sh
python3 automations/frontier-watch/report.py            # 默认最近 7 天
python3 automations/frontier-watch/report.py --since 2026-10-01
```

输出 JSON：`{since, count, items:[{feature,tool,priority,feasible,desc}]}`，由 DSH 会话整理成周报。

## 失败模式

| 情况 | 行为 |
|---|---|
| 抓取失败（网络/结构变化） | 该来源跳过，stderr 记录，其他来源继续（豆包工作的两个 RSS 任一变空都不影响 Codex/Claude） |
| 模型返回非 JSON | 本次该来源丢弃，不写脏数据 |
| Base 读取失败 | 放弃本次写入（宁可不动，也不重复写，避免重复记录） |
| 通知失败 | 只打印 stderr，不影响已写入的数据 |
| 模型 Key 缺失 | 直接退出并提示（环境变量或钥匙串） |

## 依赖

- `python3`（系统自带即可，零第三方包）
- `lark-cli` 已授权（user 身份可读写在 Base 上）
- 模型 Key：`DEEPSEEK_API_KEY`（环境变量）或钥匙串同名条目
