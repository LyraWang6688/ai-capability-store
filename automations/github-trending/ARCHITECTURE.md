# 热点管线的架构

这份文档回答：**这套「GitHub 日报 / 周报」是怎么跑起来的，代码和数据分别在哪，改动一处会影响到什么。**

日常使用不需要读它；**要改结构、排查故障、或者换了机器重建时**才需要。

---

## 0. 一句话总览

```
规则在 GitHub（代码 + 契约 + 关注清单）
数据在 GitHub 的另一个分支（data）
调度在本机 DSH（触发时间 + 十几行启动器）
分析在 DSH 会话里（agent 按规则读数据、产出报告）
收录在飞书（用户确认后写入）
```

**关键分工**：采集层不知道你在意什么，分析层不负责抓数据。

---

## 1. 时间轴

```
每天 05:17 ── 云端（不需要本机开机）
  GitHub Actions 触发 automation-github-trending-daily.yml
    run: python3 automations/github-trending/daily/scan.py > out.json
      三个源 → 四道过滤 → 排序取前 40 → 补 topics
    commit out.json → data 分支的 trending/<date>.json
    push

每天 09:00 ── 本机（需要 DSH 在运行）
  DSH 定时任务唤醒 agent
    ① python3 sync_from_cloud.py --days 7
         从 data 分支把缺失的天拉到本地缓存
    ② 读 REPORT-CONTRACT.md（报告结构，权威）
    ③ 读 interests.yaml（关注清单）
    ④ 读飞书「GitHub 优质项目收录」表（分类用）
    ⑤ 把候选分成 板块一（新增）/ 板块二（已有项目）
    ⑥ 按契约写报告，直接出现在会话里

每周日 20:00 ── 本机
  同 09:00，但先跑 weekly/aggregate.py 做一周聚合，
  先看 trustworthy，false 就只说数据不足、不硬做结论
```

---

## 2. 三层存放

### 第 1 层：GitHub `main` 分支 —— 代码和规则

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/automation-github-trending-daily.yml` | cron `17 5 * * *` + tz；跑 scan.py；提交到 data 分支 |
| `.github/workflows/automation-github-trending-weekly.yml` | cron 周日 + tz；跑 aggregate.py |
| `automations/github-trending/daily/scan.py` | **采集器**。只按客观标准筛，不知道飞书表 |
| `automations/github-trending/daily/sync_from_cloud.py` | **取数器**。从 data 分支拉缺失的天 |
| `automations/github-trending/weekly/aggregate.py` | 周度聚合，算 `star_delta` |
| `automations/github-trending/daily/README.md` | 采集脚本的 **输出契约**（脚本产出什么 JSON） |
| `automations/github-trending/daily/REPORT-CONTRACT.md` | 报告的 **内容契约**（报告长什么样）★ |
| `automations/github-trending/daily/interests.yaml` | **关注清单**（为谁分析）★ |
| `automations/registry.yaml` | 所有自动化的身份 / 版本 / 绑定关系 |

**这三个文件决定了整套系统的行为**：

```
scan.py             → 收什么
REPORT-CONTRACT.md  → 怎么写
interests.yaml      → 为谁写
```

### 第 2 层：GitHub `data` 分支 —— 数据产物

```
data 分支
└── trending/
    ├── 2026-10-17.json
    ├── 2026-10-18.json
    └── weekly-2026-10-17.json
```

**为什么单独一个分支**：`main` 是代码，改动走 PR、要 review；
`data` 每天自动提交、不需要 review。混在一起会淹没代码历史。

**为什么数据放 GitHub 而不是本机**：本机关机也能采集。这是当初从 launchd 迁到
GitHub Actions 的全部理由。

### 第 3 层：本机 —— 调度和缓存

```
~/.dsh/storages/schedule.json                              ← 触发时间 + 十几行启动器
~/.automation-state/github-trending/trending/*.json        ← 数据缓存（data 分支的副本）
```

**这两样都是「副本 / 配置」**：删了可以从仓库和云端重建。

### 另有：飞书收录表

```
base   NeujbbOfcaPEvMsPIxscaJImn9d
table  tblenXNEDtNtVIf4     「GitHub 优质项目收录」
用途   分析时读，用来把候选分成「已有项目 / 新增项目」
```

---

## 3. 每一环：谁在做、读什么、写什么

| 环节 | 谁 | 输入 | 输出 | 落在哪 |
| --- | --- | --- | --- | --- |
| 采集 | GitHub Actions | GitHub Trending 网页 + `gh search` | `trending/<date>.json` | `data` 分支 |
| 取数 | agent（本机） | `data` 分支 | 本地缓存 | `~/.automation-state/` |
| 分类 | agent（本机） | 候选 + 飞书表 | 板块一 / 板块二 两组 | 内存 |
| 分析 | agent（本机） | 三份规则文件 + 缓存 | 报告文本 | DSH 会话 |
| 收录 | agent + 用户确认 | 报告结论 | 新记录 | 飞书表 |

---

## 4. 采集的客观标准

```
三个源：
  ① trending?since=daily       当日新增星（stars today）——唯一的日速度来源
  ② trending?since=weekly      一周持续热度
  ③ gh search --created <7d --stars >200   太新还没上 trending 的

四道过滤：
  ① 按仓库去重合并，trend_gain 取最大值
  ② 噪音关键词过滤（job-search / leetcode / tutorial / awesome- …）
     例外：trend_gain >= 300 时豁免
  ③ 话题门槛：至少 2 个仓库带同一个 topic 才进 topic_frequency
  ④ 排序：trend_gain 降序 → stars 降序；取前 40 去补 topics

每条记录 7 个字段：repo / stars / trend_gain / language / desc / topics / source
```

**这些标准里没有任何一个「这条对我有没有用」的判断。** 那是分析层的事。

---

## 5. 三个关键设计

### 5.1 采集层保持中立

采集器**不知道飞书收录表里有什么**。「这个仓库我是不是已经收录过」需要查飞书表，
属于分析层的判断。

```
好处：
  · 收录新项目不用改代码（原来是硬编码名单，收一个改一次，必然落后）
  · 板块二（已有项目状态跟踪）能真正拿到数据
  · 采集器可测试、可复用、不依赖个人数据

守门：
  test_scan.py 里有 TestCollectorNeutrality —— 断言 scan 模块里没有 COLLECTED，
  且已收录仓库仍能进入 candidates。想加回硬编码名单，CI 会拦。
```

### 5.2 结构外置到仓库（**指针 vs 副本**）

这是最容易搞错的一处，单列一节。

**问题背景**：DSH 定时任务的提示词存在 `~/.dsh/storages/schedule.json` 里，
它在 DSH 的私有存储中 ——**不在 git 里、不可 review、换机器就丢**。

**改之前（副本模式）**：

```
report structure ─┬─→ 仓库的 REPORT-CONTRACT.md   （约 175 行）
                  └─→ 本机提示词里的一份完整拷贝   （约 300 行）

改结构 → 必须改两个地方 → 忘掉一个就漂移
```

**实际已经漂移过一次**：契约里是「三个维度 ①②③」，提示词里改成了「两个维度」，
仓库那份没跟着改，两边不一致。

**改之后（指针模式）**：

```
report structure ──→ 仓库的 REPORT-CONTRACT.md   ← 唯一来源
                            ↑
                    指针：本机提示词（35 行）只说「读这个文件，严格照做」
```

提示词现在的实际文本（节选）：

```
═══ ② 读两份文件，按契约产报告 ═══

**报告结构（权威，必须读）**
`~/Documents/workplace/ai-capability-store/automations/github-trending/daily/REPORT-CONTRACT.md`

**我的关注清单**
`~/Documents/workplace/ai-capability-store/automations/github-trending/daily/interests.yaml`

**严格按 REPORT-CONTRACT.md 产报告。**
...
结构不要凭记忆复现 —— **读文件**。
```

**为什么这样能生效 —— 看执行时序**：

```
09:00  DSH 唤醒 agent，把提示词文本塞进上下文
         ↓
       agent 读到「读 REPORT-CONTRACT.md」
         ↓
       agent 用 read 工具去读磁盘上【当前】那个文件   ← 每次都是最新的
         ↓
       按它写报告
```

**关键点**：提示词里没有任何结构内容，只有路径。所以文件的改动**在下次唤醒时立刻生效**，
不需要碰提示词。

**生效的三个前提**：

1. 文件路径必须稳定（现在是仓库里的固定路径）
2. agent 必须真的去读文件，不能「凭记忆复现」—— 所以提示词里写了「结构不要凭记忆复现」
3. 文件读不到时要明说，不能瞎写 —— 提示词里写了异常处理

**代价**：每次唤醒多一次文件读取（毫秒级），而且要求仓库在本机可访问。

**同理适用于关注清单**：`interests.yaml` 也只在仓库里有一份，提示词只给路径。

### 5.3 代码与数据分离

```
main 分支 = 规则（改动走 PR，有人 review）
data 分支 = 产物（每天自动写，不需要 review）
```

---

## 6. 失败路径

| 情况 | 行为 |
| --- | --- |
| 云端今天没采集到 | `today_available = false` → 报告明说「今天云端数据缺失」+ 给 Actions 诊断链接；**不许用昨天数据冒充，不许编数字** |
| 契约 / 关注清单读不到 | 直接告诉用户，**不凭记忆产报告** |
| 周报数据不足 N 天 | `trustworthy = false` → 只报「本周数据不足，趋势判断不可靠」，**不硬做结论** |
| 采集没覆盖到任何已收录项目 | 板块二明说「今天采集没覆盖到你收录的项目」，不去现查 |

---

## 7. 常见改动怎么改

| 想改什么 | 改哪个文件 | 要动提示词吗 |
| --- | --- | --- |
| 报告结构 / 板块 / 维度 | `REPORT-CONTRACT.md` | **不用**（走 PR） |
| 我在关注什么 | `interests.yaml` | **不用**（走 PR） |
| 采集的源或阈值 | `scan.py`（+ `test_scan.py`） | 不用 |
| 采集几点跑 | `.github/workflows/automation-github-trending-daily.yml` | 不用 |
| 报告几点出 | `~/.dsh/storages/schedule.json`（DSH 私有） | **只能改本机** |

**最后一行是唯一无法版本化的东西** —— DSH 的定时任务提示词存在它自己的存储里，
仓库管不到。所以它被刻意写得很短，只做「启动器」。

---

## 8. 相关文档

- [`README.md`](./daily/README.md) —— 采集脚本的输出契约
- [`REPORT-CONTRACT.md`](./REPORT-CONTRACT.md) —— 报告的内容契约（权威）
- [`interests.yaml`](./interests.yaml) —— 关注清单
- [`../registry.yaml`](../registry.yaml) —— 自动化注册表（版本 / 绑定关系）
