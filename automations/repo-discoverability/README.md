# repo-discoverability

**让你的仓库被 AI 搜到，并且被搜到之后愿意点进来。**

审计 5 项、自动补 2 项，按证据强度分级 —— 没有证据的项不进标准。

## 为什么需要它

2026-10-19 的实测：

| 体检项 | 结果 |
|---|---|
| 名下 13 个公开仓库里有 topics 的 | **0 个** |
| 有 `llms.txt` 的 | **0 个** |
| 有 description 的 | 4 个 |

而同期两个「对 agent 友好」的范例仓库：

| | `android/skills` | `morluto/rea` |
|---|---|---|
| `llms.txt` / `llms-full.txt` | ✅ | ✅ |
| `AGENTS.md` / `CLAUDE.md` | ✅ | ✅ |
| `.agents/` | ✅ | ✅ |
| topics | 1 个 | **20 个** |

**更关键的证据**：`ai-capability-store` 的 traffic 数据显示

```
网页观看    27 次 /  1 个独立访客
repo clone 1,730 次 / 331 个独立来源
```

**331 个来源 clone 过它，只有 1 个人打开过网页。** 说明这个仓库的读者**主要是 agent，不是人** ——
所以「AI 能不能搜到」不是锦上添花，是主要问题。

## 标准（按证据强度分级）

### T1 · 有本仓库实测证据 —— 必修

| # | 项 | 证据 |
|---|---|---|
| D1 | `topics` ≥ 5 | **布尔门**。topic 为 0 的仓库在 `topic:` 搜索里命中数就是 0，不是「排名靠后」。2026-10-19 实测：同名仓库打上 topics 后，`topic:agent-skills` 命中从 0 → 1 |
| D2 | `description` 20–200 字 | 搜索结果行里唯一可读的文本。没有它，结果里只剩仓库名 |
| D3 | README 前 25 行含「给谁用 / 做什么 / 怎么开始」 | `in:readme` 的可索引面远大于其它字段：同一个探针词，`in:readme` 命中 281,371 个仓库，`in:description` 只命中 2,668 个 —— **约 100 倍**。agent 读 README 的时间有限，前三行决定它要不要继续 |

### T2 · 生态约定 —— 建议（无直接测量，但成本极低）

| # | 项 | 依据 |
|---|---|---|
| D4 | `llms.txt` | [llmstxt.org](https://llmstxt.org) 约定；两个范例仓库都有。给 agent 一个机器可读的入口索引 |
| D5 | `AGENTS.md` | agent 工具（Claude Code / Codex 等）通用约定；进入仓库后先读的就是它 |

### T3 · 需要时间窗 —— 先建基线

| # | 项 | 做法 |
|---|---|---|
| D6 | traffic | GitHub 的 traffic API 只保留 **14 天**。改动的效果要在 14 天后用 `traffic/views` 和 `traffic/clones` 对比今天 |

## 自动化的边界

| 项 | 自动？ | 为什么 |
|---|---|---|
| D2 description | ✅ 自动 | 从 README 标题下的 `> 一句话` 抽取 —— 确定性，可预测 |
| D4 llms.txt | ✅ 自动 | 从 H1 + 引言 + `##` 标题生成 —— 确定性 |
| D1 topics | ❌ **只建议，不自动写** | 见下 |
| D3 README 前三行 | ❌ | 需要判断「这个项目到底解决谁的什么痛」，不能机造 |
| D5 AGENTS.md | ❌ | 内容是项目特定的规则 |

### 为什么 topics 不自动派生

第一版用 README 关键词推导 topics，第一次 dry-run 就给出两个错答案：

```
feishu-retail-ops  → ai-agents
  命中来源：文件树里的一行「├── AGENTS.md  # 仓库级 Agent 入口」
  （文件名被当成了主题）

personal-ip-hub    → inventory
  命中来源：英文「The current public project inventory SSOT is:」
  （inventory 在这里是「清单」，不是「库存」）
```

**关键词匹配分不清「文件名 / 通用词」和「主题」。而错的 topic 比没有 topic 更糟** ——
它把仓库推进一个和它无关的 topic 页，正是这个自动化要避免的垃圾信号。

所以 topics 走 `topics.plan.json`：一次性人工确认，之后自动套用。

## 运行

```bash
# 审计（只读）
python3 audit_discoverability.py --all --owner LyraWang6688

# 看会改什么（dry-run，默认不写）
python3 apply_discoverability.py --owner LyraWang6688

# 真的写 description + llms.txt
python3 apply_discoverability.py --owner LyraWang6688 --apply

# 连 topics 一起写（只从 topics.plan.json 取）
python3 apply_discoverability.py --owner LyraWang6688 --apply --apply-topics
```

退出码：`audit` 0 = 全 PASS/SKIP，1 = 有 FAIL。`apply` 0 = 无错误，1 = 有写入失败。

## 已知边界

- **归档仓库直接跳过** —— 只读，改了会被 API 403，算成 FAIL 只是噪音。
  2026-10-19 名下 13 个公开仓库里 **8 个是归档的**，真正需要做这项的只有 5 个。
- **分支保护会拦住写入** —— `ai-capability-store` 和 `feishu-retail-ops` 都要求走 PR。
  脚本不会用 `--admin` 绕过；它会报错并说明需要 PR。**这是对的**：绕过保护等于假装 CI 通过了。
- **`llms.txt` 不保证被任何 agent 读取** —— 它是 T2 约定，不是 T1 实测项。不要因为它加了就以为分数一定涨。

## 相关

- 姊妹自动化 [`repo-baseline-audit`](../repo-baseline-audit/README.md)：管**产品能不能安全运行**（安全 / CI / 合并纪律）
- 本自动化管**产品能不能被找到**（topics / README / llms.txt）
- 两者不重叠：一个修内功，一个修外功
