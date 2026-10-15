---
name: store-publish
description: 把王颖的能力资产（Skill / MCP / Plugin / CLI）按 AI Capability Store 的契约完成首次上传、迭代或引用。当用户明确说「上传这个到 Store」「把这个沉淀进商店」「更新 Store 里的 XX」「去 Store 找一下」时使用。不主动触发——必须先有明确指令。
---

# Store Publish

把能力资产按 `ai-capability-store` 的契约上传、迭代或引用。

> LLM 判断。脚本保护。人批准。

## 环境准备（每次会话跑一次）

Store 的验证器和本 skill 的脚本都需要 **PyYAML**，而很多机器的系统 `python3` 没有它。

**不要往系统 Python 里装。** 建一个独立的 venv：

```bash
STORE=$(python3 <skill-dir>/scripts/store_root.py)
python3 -m venv "$STORE/.venv"
"$STORE/.venv/bin/pip" install -r "$STORE/requirements-dev.txt"
```

之后**一律用这个解释器**跑验证：

```bash
"$STORE/.venv/bin/python" "$STORE/scripts/validate_store.py"
```

**⚠️ 不要用 `/tmp` 存放依赖** —— 系统会清理它，下一个会话又得重装。
放在 `<store>/.venv/` 里是持久的，而且 Store 的 `.gitignore` 会忽略它。

> 如果 `$STORE/.venv` 已经存在，直接用，不用重建。

## 第一步：读契约（按顺序，不可跳）

读 **Store 仓库**里的这 6 份文件。先定位仓库根：

```bash
python3 <skill-dir>/scripts/store_root.py     # 输出仓库绝对路径
```

| # | 文件 | 回答什么 |
|---|---|---|
| 1 | `AGENTS.md` | 路由：该去哪个域 |
| 2 | `CONTRIBUTING_AI.md` | 行为准则：Reuse Scan / 命名 / 分支 / **人类审批清单** |
| 3 | `PUBLISHING.md` | 发布协议：本次动作的主流程 |
| 4 | `VERSIONING.md` | 版本：`version` 放哪、怎么编号 |
| 5 | `SKILL-FORMAT.md` | 格式：`SKILL.md` 只能写什么 |
| 6 | `registry.yaml` | 顶层路由 |

**⛔ 读完这 6 份之前，不碰任何文件。** 契约内容以这 6 份为准，本 skill 不复制它们。

## 第二步：判定走哪条路

```bash
python3 scripts/reuse_scan.py <asset-name>
```

```
资产已在注册表里？
  ├─ 没有         → 读 references/first-publish.md
  ├─ 已有         → 读 references/iterate.md
  └─ 只是要装/用   → 读 references/distribute.md
```

## 第三步：执行

按对应 references 的流程做。做完必须跑**两道校验**：

```bash
# ① 生态层（在 skill 目录上跑）
npx skills-ref validate <skill-path>

# ② Store 层（在 Store 仓库根跑）
python3 scripts/validate_store.py
```

**任何一道失败都不要提交。**

## 第四步：打 tag 之前（首次上传与迭代都要）

```bash
python3 scripts/check_tag_version.py <asset-name> <version>
```

退出 `10` 就不要打 —— 它逐条确认 tag 名字没被占用、资产已登记、**目标提交里的注册表
版本与要打的版本一致**、目标提交在 main 上。想体检全仓已有 tag：`--audit`。

**版本号必须和内容变更在【同一个 PR】里改。** 拆成两个 PR 之后，没有任何提交同时满足
"内容是 vX.Y.Z"和"注册表说 vX.Y.Z"，tag 打在哪个提交上都不自洽；事后再补一个
"对齐版本"的 PR 也修不了 tag 已指向的那个提交。2026-10 真实发生过 4 次。

## ⛔ 边界（三条禁令）

1. **不主动触发** —— 必须有王颖的明确指令。禁止"我觉得这个有价值就上传"。
2. **不跳过人批准** —— 提交前必须停下，把要改什么给她看，等她点头。
3. **不替她判断"该不该收录"** —— 准入由王颖把关，Agent 只负责执行。

## 其他边界

- ❌ 不直推 `main`。
- ❌ 不修改 Store 的契约文件（`AGENTS.md` / `CONTRIBUTING_AI.md` / `PUBLISHING.md` / `VERSIONING.md` / `SKILL-FORMAT.md` / `registry.yaml`）——那属于 Store Governance，另开 PR。
- ❌ 不修改其他资产的记录。
- ⚠️ 搬代码进 Store 时必须用 `git subtree`（保留历史），**不要 `cp`**。
- ⚠️ 源不是 git 仓库时先停下问人——直接拷贝会丢历史。

## 四条最容易被判错的规则

| 规则 | 错在哪 |
|---|---|
| Skill 路径必须是 `skills/<name>/`（**恰好一层**） | 写成 `skills/shared/<name>/` 客户端根本看不见 |
| `version` 只写注册表，**不写 `SKILL.md`** | 写了会被官方校验器判死 |
| 自研能力**必须**填 `implementation_path` | 不填 → 验证器不检查 → 记录成空壳（**静默失败**） |
| 版本号和内容变更必须**在同一个 PR** | 拆开 → 没有任何提交同时满足两者 → tag 必然与注册表对不上 |
