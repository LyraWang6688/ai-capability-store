# repo-discoverability

**让你的仓库被 AI 搜到，并且被搜到之后愿意点进来。**

审计 6 项，按证据强度分级 —— 没有证据的项不进标准。
**只读 + 开 issue，不写任何仓库。**

> **给仓库负责的 AI 看的写作规范 → [`MAINTAINER-GUIDE.md`](./MAINTAINER-GUIDE.md)**
>
> 分工：本自动化负责**定义标准 + 校验 + 补确定性缺口**（llms.txt / 徽章 / description）；
> README 正文和 topics 由各仓库负责的 AI 写 —— 只有它知道仓库真实在做什么。

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
| D6 | `powered by dsh` 徽章 | 署名 + 生态可追溯性。**明确不是搜索因素** —— 见下面的警告 |

> **关于 D6 的警告（写在这里防止以后被误当成优化手段）**
>
> 徽章是一个 `<img>` 标签。GitHub 的 `in:readme` 索引的是**文本**，不是图片内容。
> 所以加徽章**不会提高任何搜索排名**，也不影响 D1/D2/D3 的索引效果。
>
> 它的价值只有两个：① 署名这个项目是用 DSH 做的；② 读到你 README 的人/agent 能顺着链接回到 DSH。
> **不要因为它加了就以为分数会涨。** 2026-10-20 首次检查时 13/13 个仓库都没有它，
> 补上是「补齐署名」，不是「提升排名」。

```markdown
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
```

### T3 · 需要时间窗 —— 已建基线

| # | 项 | 做法 |
|---|---|---|
| D7 | traffic | GitHub 的 traffic API 只保留 **14 天**，超期由服务端删除，要也要不回来。所以基线必须自己存：`traffic_baseline.py --record` 写 `~/.automation-state/repo-discoverability/traffic.json`，14 天后 `--compare` 出增量 |

**2026-10-20 记录的基线（14 天窗口）**：

| 仓库 | 观看 / 独立访客 | clone / 独立来源 |
|---|---|---|
| `feishu-retail-ops` | 47 / 2 | **18,535 / 1,917** |
| `ai-capability-store` | 27 / 1 | 1,730 / 331 |
| `Teaming-Bot` | 7 / 1 | 358 / 153 |
| `personal-ip-hub` | 0 / 0 | 10 / 10 |
| `agent-context-architecture` | 0 / 0 | 25 / 17 |

**这张表本身就是一个发现**：`feishu-retail-ops` 有 1,917 个独立来源 clone，却只有 2 个人打开网页
（比值 958:1）。正常公开项目不会有这个比例 —— 要么是部署自动化在拉，要么是被批量爬取。
**在解释任何 traffic 变化之前，先把这个异常查清楚**，否则增量都是噪声。

**判读规则**：
- 看 **`views`** 增量 —— 人/agent 真的打开了页面
- `clones` 增量混着 CI checkout、定时 workflow、你自己的 `git fetch`，**只能当参考**
- 单仓库的一次波动可能是某个人分享了一次；要看多个仓库的整体方向

## 边界：只读 + 开 issue，不写任何仓库

**这是硬边界**（用户 2026-10-20 明确）：

```
✅ 读        审计 6 项，读 README / topics / description
✅ 写 issue  只在「本仓库」开 / 改 / 关 issue（幂等）
❌ 写仓库    不改任何仓库的 README / description / topics / llms.txt / 文件
```

**为什么**：「怎么按标准执行」是用户和各仓库负责的 AI 之间的约定，不归本自动化管。
自动化管的是**发现差距并把它说清楚**，不是替人动手。

**因此也不再存在自动补**。`llms.txt` 的格式、徽章的代码，都写进
[`MAINTAINER-GUIDE.md`](./MAINTAINER-GUIDE.md) 给仓库 AI 抄，而不是由脚本写进去。


## 输出到哪

**不再只是打印报告** —— 没过的项会开成 issue，落到该干活的那个仓库里：

| 情况 | 动作 |
|---|---|
| 有 FAIL，且没有既有 issue | 🆕 开一条 `[discoverability] N 项待补` |
| 有 FAIL，已有 issue | ✏️ 原地更新（不重复开单） |
| 之前不合格，现在合格 | ✅ 自动关闭并留言 |

**幂等**靠一条隐藏 marker（`<!-- repo-discoverability-bot -->`）识别自己开的单。
所以每周跑不会有问题，也不会堆积。

**跨仓库开 issue 需要 PAT（`repo` scope）** —— Actions 默认的 `GITHUB_TOKEN` 只能写当前仓库。
脚本遇到权限不足会逐仓库报错，不会假装成功。

## 运行

```bash
# 审计（只读）
python3 audit_discoverability.py --all --owner LyraWang6688

# 生成 / 更新 issue（幂等：有则改、好则关）
python3 report_issues.py --owner LyraWang6688 --create

# traffic 基线
python3 traffic_baseline.py --owner LyraWang6688 --record
python3 traffic_baseline.py --owner LyraWang6688 --compare
```

退出码：`audit` 0 = 全 PASS/SKIP，1 = 有 FAIL。`report_issues` 0 = 无错误，1 = 有仓库写入失败。


## 审计范围

```
✅ 公开仓库          默认审计
❌ 归档仓库          跳过（只读，改不了；算 FAIL 只是噪音）
❌ 私有仓库          默认不审 —— 见下
```

**为什么私有仓库默认不审**：私有仓库不会出现在 GitHub 搜索里。
`topics` / `description` / 徽章 对它**测不出任何东西**，强行算 FAIL 是假失败。

如果确实要审（比如想让自己的 agent 更容易读），用 `--include-private`：
判据会自动降级 —— `D1` / `D2` / `D6` 标 **N/A**，只检查 `D3` README / `D4` llms.txt / `D5` AGENTS.md，
且 N/A 项**不计入分母**。

## 已知边界

- **归档仓库直接跳过** —— 只读，改了会被 API 403，算成 FAIL 只是噪音。
  2026-10-19 名下 13 个公开仓库里 **8 个是归档的**，真正需要做这项的只有 5 个。
- **分支保护会拦住写入** —— `ai-capability-store` 和 `feishu-retail-ops` 都要求走 PR。
  脚本不会用 `--admin` 绕过；它会报错并说明需要 PR。**这是对的**：绕过保护等于假装 CI 通过了。
- **weekly**：workflow 每周一晚 20:00 跑一次；issue 幂等，修好自动关闭
- **`llms.txt` 不保证被任何 agent 读取** —— 它是 T2 约定，不是 T1 实测项。不要因为它加了就以为分数一定涨。

## 相关

- 姊妹自动化 [`repo-baseline-audit`](../repo-baseline-audit/README.md)：管**产品能不能安全运行**（安全 / CI / 合并纪律）
- 本自动化管**产品能不能被找到**（topics / README / llms.txt）
- 两者不重叠：一个修内功，一个修外功
