# 仓库 README 与发现性 · 维护者规范

> **给谁看**：每个仓库的负责 AI。
> **我（审计方）负责什么**：定义标准、校验、补确定性缺口（`llms.txt` / 徽章）。
> **你（仓库负责 AI）负责什么**：README 的内容和 topics 的选择 —— 因为只有你知道这个仓库真实在做什么。

---

## 一、README 到底在给谁看

这是整个规范的前提。README 同时服务**三个不同的读者**，任何一个没照顾到都会掉分：

| 读者 | 它怎么读 | 它要什么 | 没照顾到的后果 |
|---|---|---|---|
| **① 索引器**（GitHub 搜索） | 全文索引 `in:readme` | 真实的技术词 | 搜不到 |
| **② 摘要器**（AI 联网/RAG） | 抓页面，写一段介绍给你 | 清晰的结构 | AI 介绍你的项目时说错 |
| **③ 执行器**（agent 进来用） | 找安装命令、找示例 | 可复制可运行的指令 | agent 进来了但用不起来 |

**证据**：`in:readme` 的索引面约是 `in:description` 的 **100 倍**
（同一个探针词：281,371 个仓库命中 vs 2,668 个）。
`ai-capability-store` 的 traffic 显示 **331 个独立来源 clone、只有 1 个人打开网页** —— 读者主要是 agent。

---

## 二、README 的标准结构

按这个顺序写。前三个是**硬要求**（审计会检查），后面按项目需要取舍。

```markdown
# 项目名

> 一句话：它解决谁的什么痛。
> （不是「XX 系统」，是「不用再手动做 XX」）

**给谁用**：具体到角色，不是「开发者」
**它做什么**：≤3 条，动词开头
**怎么开始**：一行可复制的命令

## 它解决什么问题
具体场景。一个真实的工作流，不要抽象描述。

## 安装
```bash
可复制的命令块
```

## 最小示例
输入 → 输出。让 agent 看完就知道怎么调。

## 核心概念
术语表：这个仓库里的专有名词是什么意思。
（agent 读到这里才能正确理解你的用词）

## 边界 / 不做什么
明确写「这个仓库不负责什么」。
（防止 agent 误用 —— 这一节经常被忽略，但价值很高）

## 相关
姊妹仓库 / 上游依赖 / 文档入口
```

### 合格 / 不合格的对比

```markdown
# ❌ 不合格
# Feishu Retail Ops
Retail operations system.

# ✅ 合格
# feishu-retail-ops

> 门店每天的对账、盘点、补货，不用再开 Excel 手工汇总 —— 扫一下，账自己落到飞书里。

**给谁用**：线下零售门店的店长 / 区域运营
**它做什么**：扫码销售、补货退货、库存、采购验收、资金对账
**怎么开始**：`npm i && npm run dev`
```

---

## 三、写 README 的七条规则

### 1. 前三行必须回答三个问题

```
给谁用     → 谁会用这个
它做什么   → 动词开头，≤3 条
怎么开始   → 一行命令
```

**审计会检查这三项是否都在前 25 行内。** 中英文都认。

### 2. 一句话要写「痛」，不是「定义」

```
❌ 以 GitHub 为 Canonical Store，让不同 AI Agent 能发现、获取、使用…
✅ 同一个 skill，在 ChatGPT 能装、在 Claude 也能装 —— 因为你有一套自己的仓库
```

**检验方法**：把这句话念给一个不看代码的人听，他能说出「这解决什么问题吗」。

### 3. 用真实技术词，不要堆砌

**关键词是给索引器的，但堆砌会被排序惩罚**（而且摘要器会把人话读成广告词）。

```
✅ 在描述里自然出现：MCP、skill、飞书、FastAPI
❌ 结尾加一坨：#ai #ml #llm #agent #gpt #claude #mcp #skill …
```

**判断标准**：这个词是不是**真的在你仓库里出现**（代码/配置/依赖）。是就留着，不是就删。

### 4. 安装命令必须能直接复制运行

```bash
# ✅ 完整、带包名
npm install -g ai-quote-clip

# ❌ 缺上下文
npm i
```

### 5. 写「边界 / 不做什么」

**这一节的价值被严重低估。** 它防止两类问题：

```
· agent 误以为你能做 XX，调用失败后判你不合格
· 人类误以为这是个大而全的东西，用完失望
```

例子：

```markdown
## 不做什么

- 不做投资建议（`investdesk-portfolio` 只分析已有持仓）
- 不抓取行情（那是 `investdesk-quote-sync` 的职责）
- 不写飞书 Base（收录必须等人确认）
```

### 6. 术语表让 agent 不误解你的用词

同一个词在不同项目里意思完全不同。**在 README 里定义它**：

```markdown
## 核心概念

- **能力资产**：可被多个 AI Host 加载的 Skill / MCP / CLI，不是一次性提示词
- **Canonical Store**：唯一事实源，不是副本
```

### 7. 改动 README 后，同步检查 topics

**README 变了，topics 可能要变。** 这是最容易漏的一步。

---

## 四、topics 怎么选（这部分归你，不归我）

### 为什么我不替你选

第一版自动化用 README 关键词推导 topics，**第一次 dry-run 就错两个**：

```
feishu-retail-ops → ai-agents   ← 命中文件树里的一行「├── AGENTS.md  # 仓库级 Agent 入口」
personal-ip-hub   → inventory   ← 命中「The current public project inventory SSOT is:」
```

关键词匹配分不清「文件名 / 通用词的另一种意思」和「主题」。
**而 topic 是布尔门 —— 错了比没有更糟**，它会把仓库推进一个无关的 topic 页。

### 选择规则

| 规则 | 说明 |
|---|---|
| **`len(topics) >= 5`** | 硬下限。少于这个数，在 topic 搜索里的覆盖太窄 |
| **每个 topic 必须是 GitHub 上真实存在的** | 已在用的词 > 自造的词。自造词等于自娱自乐 |
| **技术栈 1–2 个** | `python` / `typescript` / `astro` … |
| **领域 2–3 个** | `feishu` / `bitable` / `retail` / `ocr` … |
| **生态 1–2 个**（如果适用） | `mcp` / `agent-skills` / `claude-code` / `dsh-plugin` / `ai-agents` |
| **能对上 README** | topic 和 README 说的不是一回事 → 删掉那个 topic |

### 怎么判断一个 topic 该不该加

问自己三个问题，**三个都要「是」**：

```
① 这个仓库里真的有它的痕迹吗？（代码/配置/依赖/文档）
② 一个搜这个词的人，看到这个仓库会觉得「对，我找的就是它」吗？
③ 这个 topic 下的其他仓库，和这个仓库是同一类东西吗？
```

**任何一个「否」→ 不加。**

### 反例：不要为了蹭流量加 topic

```
❌ 加 ai-agents 只因为 README 里出现过 "agent" 这个词
❌ 加 mcp 但仓库里没有任何 MCP 实现
❌ 加热门 topic（llm / chatgpt）但和项目无关
```

**这会让你进到一个不该在的列表里，看的人是白来一趟，长期是负资产。**

---

## 五、每个仓库 AI 的维护清单

### 新开仓库时

- [ ] README 按「第二节结构」写，前三行回答三问
- [ ] `description` 20–200 字，说「给谁、解决什么」
- [ ] `topics` ≥ 5 个，按「第四节规则」选，每条过一遍三问
- [ ] 有安装/使用命令（可复制）
- [ ] 写「边界 / 不做什么」
- [ ] 如果需要 agent 读：加 `AGENTS.md`

### 每次改 README 时

- [ ] 前三行是否还准确（项目定位变了没有）
- [ ] topics 是否还匹配（README 改了主题，topics 要跟着改）
- [ ] 安装命令是否还有效

### 定期（审计会提醒）

- [ ] `llms.txt` 是否过期（README 章节变了要重新生成）
- [ ] `powered by dsh` 徽章是否还在
- [ ] `description` 是否还准确

### 交接给别的 AI 时

- [ ] 确认 topics 清单有出处（写进新仓库的 `AGENTS.md` 或 README，不要让下一个人重新猜）

---

## 六、审计方负责什么（边界很硬）

| 做什么 | 怎么做 |
|---|---|
| **校验 6 项** | `audit_discoverability.py` —— 只读，可反复跑 |
| **开 issue** | `report_issues.py` —— 不合格就开，修好自动关；幂等 |
| **记 traffic 基线** | `traffic_baseline.py`（traffic 只留 14 天，必须自己存） |
| **不写任何仓库** | 不改 README / description / topics / llms.txt / 文件 —— 一个字节都不写 |

**为什么**：「怎么按标准执行」是你（仓库负责 AI）和用户的约定。
审计方只负责**发现差距并把它说清楚**，不替人动手。

所以下面这些**都得你自己做**，脚本不会代劳：

```bash
# 自己跑校验，看还缺什么
python3 ~/Documents/workplace/ai-capability-store/automations/repo-discoverability/audit_discoverability.py \
  LyraWang6688/<repo>
```


## 六·补 · 两段可以直接抄的代码

因为自动化**不写仓库**，这两样要你自己加。

### `llms.txt` 模板

放在仓库根目录。给 agent 一个机器可读的入口索引：

```markdown
# <项目名>

> <README 标题下那句引言>

## 核心文档

- [README](./README.md)：项目说明与用法
- [AGENTS.md](./AGENTS.md)：agent 进仓库前先读的规则   ← 有就写，没有删掉这行

## 主要章节

- <README 里的一级标题，3–8 条>

## 怎么用这份索引

这是给 LLM / agent 的机器可读入口：先读核心文档，再按章节名定位。
```

### DSH 徽章

放在 README **末尾**：

```markdown
[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
```

**再提醒一次**：这是 `<img>`，GitHub 的 `in:readme` 索引文本不索引图片内容，
所以它**不影响搜索结果**，纯粹是署名和生态可追溯。

## 七、这套标准的证据基础（别凭感觉改它）

| 项 | 证据 | 证据强度 |
|---|---|---|
| D1 topics | 布尔门；实测 0 topic 时 `topic:` 搜索命中 0，打上后命中 1 | **强** |
| D2 description | 搜索结果行唯一可读文本 | 中 |
| D3 README 前三行 | `in:readme` 命中 281,371 vs `in:description` 2,668 | **强** |
| D4 `llms.txt` | llmstxt.org 约定；两个范例仓库都有 | 弱（无测量） |
| D5 `AGENTS.md` | agent 工具通用约定 | 弱（无测量） |
| D6 DSH 徽章 | 署名 + 生态可追溯。**明确不是排名因素**（图片不被索引为文本） | 无（纯署名） |
| D7 traffic | 唯一能测「有没有用」的仪器；今天记基线，14 天后比 | 测量工具本身 |

**改标准之前先问：新加的这项，证据在哪？** 没有证据的项可以进 T2，但**不许进 T1**。
