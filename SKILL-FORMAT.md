# SKILL-FORMAT.md — 一个 Skill 必须长什么样

> **怎么用这份文件：**
> 把下面这个链接丢给任何 Agent，让它按这个格式生产 Skill。
>
> ```text
> https://github.com/LyraWang6688/ai-capability-store/blob/main/SKILL-FORMAT.md
> ```
>
> 这份文件是**生产侧的模板**，同时是**收录侧的验收依据**。一份文件，两个用途。
> 详见 [§8 给 AI 的生产提示词](#8-给-ai-的生产提示词复制即用)。

---

## 0. 先分清两层要求

| 层 | 谁定的 | 不遵守会怎样 | 谁验 |
|---|---|---|---|
| **【生态要求】** | 外部标准（见 [§9](#9-依据的外部标准)） | **装不上**，或客户端根本看不见这个 skill | `npx skills-ref validate <path>` |
| **【Store 要求】** | 本仓库 | 能装，但**登记不进 Store** | `python3 scripts/validate_store.py` |

**两层都要过。** 大多数 Agent 自带的模板只满足它们自己平台的要求，**不一定满足这两层**。

---

## 1. 目录结构

```text
skills/<skill-name>/
├── SKILL.md            ← 必需 —— 生态要求
├── agents/
│   └── openai.yaml     ← 必需 —— 【Store 要求】，生态不要求（见 §5）
├── scripts/            ← 可选（确定性可执行逻辑）
├── references/         ← 可选（按需加载的知识）
├── assets/             ← 可选（模板 / 图标 / 输出资源）
└── ...                 ← 其他文件/目录都可以
```

> **`agents/openai.yaml` 是 Store 额外加的，不是生态要求。**
> 官方说它是 *"product-specific config"*（Codex 专用）。当前 Store 要求每个 skill
> 都带一份，原因是 Codex（含 ChatGPT 桌面版）是我们主力宿主之一。
> **这条要求正在复核中** —— 若将来认为不该强制，会改为可选。

### ⚠️ 平铺：skill 必须是 `skills/` 的**直接子目录**

```text
✅ skills/repo-hygiene/SKILL.md
❌ skills/shared/repo-hygiene/SKILL.md      ← 多一层，客户端看不见
❌ skills/projects/foo/bar/SKILL.md          ← 多两层
```

**原因**：Agent Plugins v1 §7.1 原文 ——

> *"Each **immediate child directory** containing a path named exactly `SKILL.md` ... is treated as one skill. Clients **MUST NOT recursively search deeper descendants**."*

**分类（跨项目 / 项目专属）不是目录层级，是注册表字段 `scope`。**

---

## 2. `SKILL.md` frontmatter — 封闭白名单

**只允许这 6 个字段。多一个就校验失败。**

| 字段 | 必需 | 约束 |
|---|---|---|
| `name` | ✅ | 1–64 字符；只能小写字母 / 数字 / 连字符；**不能以连字符开头或结尾**；**不能有连续连字符**；**必须等于父目录名** |
| `description` | ✅ | 1–1024 字符；非空；必须说清「做什么」+「什么时候用」 |
| `license` | | 许可证名，或指向附带 LICENSE 文件的说明 |
| `compatibility` | | 1–500 字符；**环境要求**（见 [§5](#5-运行时依赖怎么写)） |
| `metadata` | | 任意键值对，**键和值都必须是字符串** |
| `allowed-tools` | | 空格分隔的预批准工具（**实验性，各客户端支持不一**） |

> 最后两个字段曾经只是"白名单放行"，没有验形状 —— 写 YAML 数组、写多行块标量都能过。
> 现在两者的形状也检查了：`license` 必须是非空字符串；`allowed-tools` 必须是**单行、
> 空格分隔**的字符串（`[Read, Write]` 和多行 `|` 都会被拦）。

**最小可用形态：**

```markdown
---
name: repo-hygiene
description: Audit and safely clean a Git repository. Use when the user asks for repository hygiene or workspace cleanup.
---

# Repository Hygiene

（正文）
```

> ⚠️ **最常见的违规：写 `version`。** 生态规范里**没有** `version` 这个顶层字段。
> 版本由 Store 的 `skills/registry.yaml` 承载，**不写进 SKILL.md**。
> 见 [VERSIONING.md](./VERSIONING.md)。

---

## 3. `name` 必须等于父目录名

```text
✅ skills/repo-hygiene/   →  frontmatter: name: repo-hygiene
❌ skills/repo-hygiene/   →  frontmatter: name: RepoHygiene     （大写）
❌ skills/repo-hygiene/   →  frontmatter: name: repo_hygiene    （下划线）
❌ skills/repo_hygiene/   →  frontmatter: name: repo-hygiene    （目录名不符）
```

**`name` 是机器身份。** 目录名、注册表 key、frontmatter `name` —— **三者必须一致**。

---

## 4. `description` 是**触发器**，不是介绍

Agent 靠 `description` 判断「这个任务该不该用这个 skill」。所以它必须写**什么时候用**，而不只是**这是什么**。

| ❌ 差 | ✅ 好 |
|---|---|
| `Helps with PDFs.` | `Extracts text and tables from PDF files, fills PDF forms, and merges PDFs. Use when working with PDF documents, forms, or document extraction.` |
| `仓库清理工具` | `审计并安全清理 Git 仓库：先分类缓存/本地数据/历史文档/遗留工具残留，再决定删除或迁移。当用户要求仓库整理、工作区清理、清理陈旧工具目录、处理生成物或迁移文档时使用；不要用它自动处置 worktree 或未推送的工作。` |

**三段结构最稳：**

```text
① 做什么      —— 一句话说清能力
② 什么时候用  —— 列举触发场景 + 关键词
③ 什么时候不用 —— 划清边界（可选但强烈建议）
```

---

## 5. 运行时依赖怎么写

**这是最容易出错的一环**：同一个 skill，在这个宿主能跑、换个宿主就跑不起来 —— 因为没人知道它需要什么。

**两个位置，分工不同，不算重复：**

| 位置 | 写给谁 | 形态 | 例子 |
|---|---|---|---|
| **`compatibility`**（SKILL.md） | **人 / 模型** | 自由文本**说明** | `"需要 bash 与 git；无需网络；不能在 Windows 原生环境运行"` |
| **`agents/<host>.yaml`** | **宿主程序** | 结构化**声明** | 见下 |

### `compatibility` —— 写"需要什么"

```yaml
compatibility: "需要 bash 与 git；需要网络访问 GitHub；不需要任何 MCP"
```

**只写"不看就会做错"的环境事实。** 别把它写成教程。

### `agents/` —— 写"怎么接"

宿主专用配置放这里。**Codex（含 ChatGPT 桌面版）读 `agents/openai.yaml`：**

```yaml
interface:
  display_name: "Repository Hygiene"
  short_description: "Audit, classify, migrate, and safely clean repositories"
  default_prompt: "Use $repo-hygiene to audit this repository, classify cleanup candidates, and prepare a human-approved safe cleanup plan."

dependencies:
  tools:
    - type: "mcp"
      value: "github"
      description: "GitHub MCP server"
      transport: "streamable_http"
      url: "https://api.githubcopilot.com/mcp/"
```

**其他宿主可以有各自的 `agents/<host>.yaml`。** `agents/` 这个目录就是为"产品专用配置"留的。

> 依据：*"`agents/openai.yaml` is an extended, **product-specific** config intended for the machine/harness to read, not the agent. Other product-specific config can also live in the `agents/` folder."* —— OpenAI Codex

**职责不重叠：`compatibility` 说"需要什么"，`agents/` 说"怎么接"。**

---

## 6. 正文怎么写

`SKILL.md` 正文**没有格式限制**，但有两条实践要求：

### ① 保持聚焦 —— 细节外置

Agent 一旦决定使用这个 skill，就会**整份读进来**。所以正文只放主线。

```text
SKILL.md          ← 流程主线 + 路由（保持精简）
references/       ← 细节按需加载（reference.md / forms.md / 领域文档）
scripts/          ← 确定性逻辑（不要让模型去"算"）
```

### ② 分三类内容，别混

```text
LLM 做语义判断       →  写在正文里（怎么判、判什么）
脚本做确定性保护     →  放 scripts/，并在正文里说明何时调用
人做高风险授权       →  在正文里明确标出【停下来等人批准】的节点
```

---

## 7. 自检

生产完成后，**两道都要跑**：

```bash
# ① 生态层
npx skills-ref validate <path/to/skill>

# ② Store 层（在 store 仓库根目录跑）
python3 scripts/validate_store.py
```

**任何一道失败都不要提交。** 尤其注意 `skills-ref` 的报错 —— 它抓的都是"装不上"级别的毛病。

---

## 8. 给 AI 的生产提示词（复制即用）

把下面这段连同链接一起发给 Agent：

```text
请按这个格式规范生产一个 Skill：
https://github.com/LyraWang6688/ai-capability-store/blob/main/SKILL-FORMAT.md

要求：
1. 严格按该文件的 frontmatter 白名单写，不要添加任何额外顶层字段
   （特别是不要写 version —— 版本由 Store 注册表承载）
2. name 必须等于目录名，全小写连字符
3. description 必须写清"做什么"+"什么时候用"
4. 有环境要求就写 compatibility；有宿主专用配置就放 agents/<host>.yaml
5. 正文保持聚焦，细节放 references/，确定性逻辑放 scripts/
6. 生产完成后自检：
   - npx skills-ref validate <path>
   - python3 scripts/validate_store.py
```

---

## 9. 依据的外部标准

| 层 | 标准 | 谁在管 |
|---|---|---|
| Skill 内容格式 | [agentskills.io/specification](https://agentskills.io/specification) | `agentskills/agentskills` |
| Skill 打包与发现 | [agent-plugins.org/specification](https://agent-plugins.org/specification) | TSC：Amazon / Cursor / Microsoft / OpenAI / Vercel |
| Skill 参考校验器 | `skills-ref`（npm 包） | 同 `agentskills` |
| 宿主专用配置 | OpenAI Codex `agents/openai.yaml` | OpenAI |

**本仓库不重新定义这些协议。** 本文件只做两件事：**把生态要求固化下来**，以及**声明 Store 的额外要求**（哪些是 Store 加的，都在文中标了）。
