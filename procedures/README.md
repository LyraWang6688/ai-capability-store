# Procedures Domain — 确定性执行

**Domain: Procedures = How to do it, deterministically**

`skills/` 和 `procedures/` 回答的是**同一个问题**——"这件事怎么做"——区别只有一个：
**谁来执行**。

| | `skills/` | `procedures/` |
|---|---|---|
| 执行者 | **模型** | **机器** |
| 载体 | 自然语言指令 | 可执行实现（python / node / bash） |
| 判断 | 需要（边界、例外、措辞） | 不需要（穷举分支） |
| 验证 | 靠覆盖样例与验收报告 | 靠 `assert` |
| 复制成本 | ≈0（文本进上下文即可） | 中（是代码，但要能跑起来才算数） |
| 失效方式 | 人用着觉得不对 | 测试红，或运行时报错 |

**判据（四问，全"是"才是 procedure）**：输入能脱离对话、输出能被断言、分支能穷举、
目标宿主能跑。任一为"否"就留在 `skills/`。详见 [`README.md`](../README.md) §Commerce
对"可卖性"的同类推理——两个域用的是同一种"先定判据再归类"的做法。

## What belongs here

| Belongs here | Does NOT belong here |
|---|---|
| 一段确定性的数据处理 / 转换 | 需要品味判断的内容（→ `skills/`） |
| 一个可被编排调用的操作（发一篇文章、同步一次价格） | 操作界面的那条作业（→ `orchestrations/computer-automation/`） |
| 被 ≥2 个资产引用的共用实现 | 只有一个消费者的小脚本（留在那个资产的 `scripts/` 里） |
| 有 `entrypoint`、能单独跑起来的东西 | 服务端实现（→ `external-capabilities/`，或店外仓库） |

## 和另外三个模块域的关系

```text
skills/                 怎么做 · 模型判断
procedures/             怎么做 · 机器确定    ← 本域
external-capabilities/  能调什么（API / MCP / CLI / 只有界面的软件）
```

一个 procedure **可以被** `orchestrations/` 的某一步引用（`steps[].use:`），
**也可以**被人手动跑。编排不拥有它，只决定"什么时候、按什么顺序"用它。

## Placement

```text
procedures/<procedure-name>/
├── README.md          人读：跑什么、要什么前提、什么情况下别用
├── entrypoint         可执行入口（.py / .mjs / .sh，或 package 的 bin）
├── ...                该 procedure 自己的实现与测试
└── test_*.py          entrypoint 的测试（有确定性分支就必须有）
```

平铺：`procedures/<name>/` 就是一层。分类（浏览器 / 桌面 / 接口）**不是目录层级**，
是注册表字段——同一个理由见 [`skills/README.md`](../skills/README.md)：
分类是 registry 状态，不是目录结构。

## 注册表字段

必需：`name` / `path` / `status` / `version` / `updated` / `entrypoint` / `runtime`。
`runtime` ∈ `python` / `node` / `bash` / `binary`。

状态词汇沿用生命周期五档（`draft` / `testing` / `active` / `deprecated` / `archived`），
理由见 [`VERSIONING.md`](../VERSIONING.md)——同一个心智模型覆盖所有域。

**入域有两种方式，都不是"它是个脚本"：**

| 方式 | 含义 | 例 |
|---|---|---|
| ① 被复用的实现 | 有 ≥2 个消费者。只服务一个资产的脚本留在那个资产的 `scripts/` 里；一旦第二个资产要用它，它就无主了，才必须升格成域资产 | 写飞书 Base（现在 5 处各写了一遍） |
| ② 本身就是一项操作 | 它是一个完整的、会被反复执行的动作，有自己的入口与产出 | `platform-intel`（抓四平台三层信息出报告） |

②存在的理由：这类东西不是"某个资产的辅助脚本"，它自己就是个动作。把它塞进
某个 skill 的 `scripts/` 里，会让那个 skill 变成"带着一条流水线的 skill"，两边都不合身。

## Commerce

本域的资产可以是 `free` 或 `paid`，规则见 [`COMMERCE.md`](../COMMERCE.md)。
确定性脚本本身**不是收费载体**（可复制、可 fork）——它能承载收费的方式只有两种：
作为 `hosted` 服务的一部分，或作为 `self-api` 那个薄壳的执行端。
