# frontier-watch

每周一 10:00（Asia/Shanghai）抓取三个前沿工具的新功能，**提取成结构化条目写进飞书 Base**，
供"把好用的功能做成 DSH 插件"这条线取材。

- **Codex**：GitHub `openai/codex` Releases（有完整 Release Notes）
- **Claude**：`support.claude.com` 发布说明页
- **豆包工作**：暂无公开 changelog，本版不自动抓取（表格里的历史条目是人工补的）

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

- `trigger_kind: weekly`，cron 只写在 `deploy/com.lyrawang.frontier-watch.plist.tmpl`（周一 10:00）
- `executor: launchd`：写飞书 Base 复用操作者本机 `lark-cli` 的 **user 令牌**（在钥匙串里），
  hosted runner 没有钥匙串，所以不用 GitHub Actions
- 安装：`bash deploy/install.sh`（写入 `~/Library/LaunchAgents/` 并 bootstrap）

## 代码 vs 状态

| | 位置 | 说明 |
|---|---|---|
| 代码 | 本目录（Store 检出） | 可审阅、可版本化 |
| `config.json` | `~/.automation-state/frontier-watch/` | Base token / 表 id / 模型，600 权限，**不进仓库** |
| `state.json` | 同上 | 已处理 Codex 版本、Claude 页面哈希、已写功能名（去重） |
| 日志 | 同上 | `watch.out.log` / `watch.err.log` |

初始化：

```sh
mkdir -p ~/.automation-state/frontier-watch
cp config.example.json ~/.automation-state/frontier-watch/config.json
# 填 base_token / table_id，然后：
python3 watch.py          # 手动跑一次验证
bash deploy/install.sh    # 安装周一 10:00 的定时任务
```

## 失败模式

| 情况 | 行为 |
|---|---|
| 抓取失败（网络/结构变化） | 该来源跳过，stderr 记录，另一个来源继续 |
| 模型返回非 JSON | 本次该来源丢弃，不写脏数据 |
| Base 读取失败 | 放弃本次写入（宁可不动，也不重复写） |
| 模型 Key 缺失 | 直接退出并提示（环境变量或钥匙串） |

## 依赖

- `python3`（系统自带即可，零第三方包）
- `lark-cli` 已授权（user 身份可读写在 Base 上）
- 模型 Key：`DEEPSEEK_API_KEY`（环境变量）或钥匙串同名条目
