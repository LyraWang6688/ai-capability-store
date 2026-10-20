# github-trending — 报告契约

这个文件规定**消费端拿到云端快照后，报告必须长什么样**。

它约束的是 **DSH 会话里生成报告的那个 agent**，不是采集脚本
（采集脚本的输出契约在 [`daily/README.md`](./daily/README.md)）。

> **这个文件是权威版本。**
> 定时任务里的提示词只负责说「读这个文件并照做」——
> 提示词存在 DSH 自己的存储里，跟本仓库没有自动关联。
> **结构一变，改这一个文件就够，提示词不用动。**
> 但提示词里如果写死了某一节的名字，改名时**要同步改**。

渲染器 [`render_report.py`](./render_report.py) 按本契约的 JSON 形状产出 HTML。

---

## 1. 数据来源约束（不可协商）

- 数据**只来自 `data` 分支**（云端采集）。本地不跑采集脚本、不做网络抓取。
- 先同步（把本地缺失的天从 data 分支补下来）：

```bash
python3 ~/Documents/workplace/ai-capability-store/automations/github-trending/daily/sync_from_cloud.py \
  --days 7 --json
```

看输出的 `today_available`。
- `today_available = false` → 直接说「今天云端数据缺失」，给出诊断方向
  （去 Actions 看 `automation-github-trending-daily` 的最近一次运行）。
  **不许用昨天的数据冒充今天，不许编任何数字。**
- 报告开头必须标明：`数据来源：云端（data 分支） · 采集于 YYYY-MM-DD HH:mm`
- **`today_status` 有三种，不能混**：
  - `available` → 正常出报告
  - `absent` → 云端确实没产出，说「今天云端数据缺失」
  - `unreadable` → **读不到**（网络/权限/限流），不是没有。说「读不到，可能是瞬时故障，建议重跑」，
    **不要说「云端数据缺失」** —— 那是把「不知道」说成了「没有」
- **`warnings` 非空 → 报告里必须提一句**：哪个源退化了、影响了什么。
  例：`trending-weekly` 崩了 → 只在 weekly 榜的项目当天不进候选。
  **不要把降级的数据当正常数据照常分析。**

## 2. 采集层是中立的，分类是分析层的事

采集脚本按它自己的标准产出一份**中立的候选清单**，它**不知道飞书收录表里有什么**。

分析开始前必须先分类：

| 组 | 判据 | 去哪 |
| --- | --- | --- |
| **已有项目** | `Project` 出现在飞书「GitHub 优质项目收录」表里 | 第三节 |
| **新增项目** | 不在表里 | 第一、二节 |

读表方式：用 `repo-collector` skill 的 `scripts/target.json` 里的
`base_token` / `table_id`，跑 `lark-cli base +record-list --as user`。

---

## 3. 报告的五个小节

顺序固定。**每节用自己的名字，不用编号代称。**

```
一、社区在追什么
    1. 热点是什么        （图）
    2. 在解决什么问题     （卡片）
    3. 和我的关系         （表）
二、我在做的事，谁也在做
三、我收的项目，现在怎么样
四、dsh-plugin 生态
五、可以做什么
```

---

### 一、社区在追什么

**只讲社区，这一节不要掺「我」。**

#### 1. 热点是什么 → 图

用 `topic_frequency` 和 `trend_gain` 支撑。给两张图：

- **话题出现次数**（横向条形图）
- **净增星最多的新项目**（横向条形图）

每张图下面一句话说明判据。**跨日净增星是算出来的派生值，不是榜上的 `trend_gain`** ——
这两个数会不一致，要说清用的是哪个。

#### 2. 在解决什么问题 → 卡片

每个热点话题一个底层问题，一句话。**不要复述项目描述。**

- ❌「X 是一个 agent skills 框架」= 复述
- ✅「agent 装了一堆 skill 后互相冲突、不知道怎么选」

#### 3. 和我的关系 → 表

把 1 的**每个话题**都过一遍，映射到关注清单里的方向。**无关的也要写「无关」**。

| 话题 | 关联方向 | 类型 | 一句话 |
| --- | --- | --- | --- |
| … | 方向名（core/watch）／ 无 | 补充 / 替代 / 印证 / 无关 | 具体关联在哪 |

---

### 二、我在做的事，谁也在做

**这是反向映射**：从我的方向出发，去社区里找「做类似事情的人」。

按关注清单过，**只过 `core`**（`watch` 有亮的才提，`observe` 不主动提）：

```
【方向名】
　我的进展：有 / 没有 —— 证据（仓库 + 数字）
　山上有谁：
　　· 有 → 谁（指到仓库）、做到哪一步、和我做的是同一件事还是相邻的事
　　· 没有 → 明写「没看到」
　处境：领先 / 同步 / 落后 / 无人区
```

处境怎么落：

|  | 社区没动静 | 社区也在做 |
| --- | --- | --- |
| **我在做** | 领先 —— 早期机会，也可能死路 | 同步 —— 看别人怎么解 |
| **我没跟** | 无人区 —— 自己判断值不值得走 | 落后 —— 最该警惕 |

**「落后」最有价值**：社区热而我不在跟时必须点出来，
不要因为那个方向不在关注清单里就跳过。

---

### 三、我收的项目，现在怎么样

**只写采集数据里真正匹配到的项目。**

渲染成一张表，列固定为：

| 仓库 | 它是什么 | 昨天 | 今天 | 跨日增长 | 今日榜速度 |
| --- | --- | --- | --- | --- | --- |
| `morluto/rea` | Reverse engineer anything with agents… | ⭐325,587 | ⭐336,612 | +11,025 | 测不到 |

- **它是什么**：取仓库的 GitHub `description` 原文（不可省，见 §5）
- **昨天 / 今天**：相邻两天快照里的星数
- **跨日增长**：`今天 − 昨天`，**用星数差算**（不可用 `trend_gain` 代替）
- **今日榜速度**：`+N`（source 含 trending-daily）／ `测不到`（只有 trending-weekly）

⚠️ **`trend_gain` 为 `null` 不是 0**：weekly 榜没有 `stars today` 字段。
增长**必须用星数差算**，不要信 `trend_gain` —— `morluto/rea` 两天涨 11,701 星，
但它的 `trend_gain` 改造前是 `0`、改造后是 `null`。

⚠️ 如果今天采集没覆盖到任何已收录项目，明说一句，不要假装有数据。

---

### 四、dsh-plugin 生态

数据来自采集层的 **`dsh_plugins` 字段**（`gh search repos --topic dsh-plugin`）——
这是**观察名单，不是趋势信号**：它能在项目第一天就发现它，而 trending 只暴露已经火了的。

**按星数取前 3 名**，每个给：

```
【仓库名】⭐星数
　它是什么：一句话
　佐证：topics 里除了 dsh-plugin，还有没有 dsh / cordis / deepseek-harness
```

⚠️ **这个 topic 有自我堆砌**：`Molunerfinn/PicGo`（图床）、`reactive-resume`（简历）
也打了这个标签。所以**佐证那一行不能省** —— 它是判断真伪的唯一依据。
如果前 3 名里出现明显不相关的，直接指出来，不要替它圆。

---

### 五、可以做什么

**0-3 个动作。** 真值得才写，没有就写「今天没有值得动手的」。

每个写：**做什么 / 为什么是现在 / 第一步**。

优先从「落后」（社区热我没跟）和「领先」（我早于社区）里挑；
同步和无人区通常不急着动。

---

## 4. 关注清单

第一节的 3 和第二节整段都依赖关注清单，格式在 [`interests.yaml`](./interests.yaml)。

- 三级：`core`（必须给结论）/ `watch`（有亮点才提）/ `observe`（只在特别相关时提）
- 改关注 = 改这个文件走 PR
- 防腐：某个 `core` 连续多日「山上有谁 = 没看到 + 我也没进展」→ 提醒降级或删除

## 5. 通用约束

- **介绍任何仓库时，必须有一列「它是什么」** —— 取仓库的 GitHub `description` 原文，或一句话概括。
  只给仓库名和星数，读者不知道它是干什么的，等于没介绍。
  这条适用于报告里**每一张**列了仓库的表（第三节、第四节都算）。
- 话题分析基于 `topic_frequency` 和 `trend_gain`，不凭感觉
- 每个判断都要能指回具体仓库
- **星多不等于无关**（反例：`morluto/rea` 31 万星，但 topics 有 `dsh-plugin`）；
  **星少也可能关键**
- MCP / CLI 只是形态，看能力本身 —— 操作者有 bash，大多数 MCP 是冗余的
- **自动化方案的稳定性优先级：API > 协议/CLI > UI 元素树 > 截图视觉**
  - GUI 方案只在对方没有 API 时才值得考虑
  - 采用 GUI 方案时要提示「对方开放 API 后应迁走」
- 之前推荐过的项目跳过
- **不要自动写飞书 Base** —— 收录必须等人确认

## 6. 周报的差异

同一套五节，差异在判据：

| 位置 | 日报 | 周报 |
| --- | --- | --- |
| 一 · 1 | `topic_frequency` + `trend_gain` | `topics_persistent` vs `topics_emerging`，看 `days_present` |
| 二 · 我的进展 | 当日数字 | **`star_delta`（一周净增）**，不用 `peak_daily_gain` |
| 三 · 跨日增长 | 相邻两天 | 整周累计，并对比收录时的 ⭐ |

周报额外要看**跨周方向性变化**：

- 某个 `core` 连续几周「山上有谁 = 没看到 + 我也没进展」→ 判断是自己太早，还是确实没需求
- 连续几周「有越来越多人在做」→ 赛道在变热，要加速或被淹没
- 连续几周「落后」→ 该补上或明确放弃
- 某个 `core` 连续 3 周以上「无人区 / 落后」→ 建议降级或从清单删除

**这类判断日报告诉不了，是周报存在的理由。**

**周报先跑聚合**（本地算，不联网）：

```bash
python3 ~/Documents/workplace/ai-capability-store/automations/github-trending/weekly/aggregate.py \
  --data-dir ~/.automation-state/github-trending/trending
```

看返回的 `trustworthy`：为 `false` 时只报「本周数据不足 N 天，趋势判断不可靠」，
**不硬做结论**。同时也别忘看 `topics_persistent` / `topics_emerging` /
`repos_climbing_by_stars` —— 周报的判据用它们，不用 `trend_frequency`。

## 7. 产出 HTML

文字版写完后，产一份 HTML。渲染器在 [`render_report.py`](./render_report.py)。

**第一步：把报告内容写成 content JSON**
schema 见 `render_report.py` 顶部的文档字符串。

**第二步：渲染**

```bash
python3 ~/Documents/workplace/ai-capability-store/automations/github-trending/render_report.py \
  <content.json> \
  -o ~/.automation-state/github-trending/reports/<日期>-<daily|weekly>.html
```

**ECharts 依赖**：默认找
`~/.automation-state/github-trending/reports/vendor/echarts.min.js`。
缺了会报错并给出取包命令 —— **不静默降级**。

**分工**：脚本只管排版，内容全在 content JSON 里。
**不要为了填满某节而硬凑。**

**输出是单文件**（ECharts 内联），离线可用、可分享。

## 8. 相关文档

- [`daily/README.md`](./daily/README.md) — 采集脚本的输出契约
- [`interests.yaml`](./interests.yaml) — 关注清单
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — 整条管线怎么跑、改一处影响什么
- [`README.md`](./README.md) — 这个 family 为什么存在
