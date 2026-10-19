---
name: repo-wrapup
description: 清理 agent 自己留下的分支 / worktree / PR，并在交付时生成一份可核验的「收尾报告」，让「工作区干净了吗」不再需要靠人追问。当一次任务完成、PR 已合并或关闭、准备交接给另一个 agent、或用户说「收尾 / 清理分支 / 工作区干净了吗 / 把 worktree 清掉」时使用；也可用于定期体检本机所有项目。不要用它清理代码、依赖或死文件（那是 repo-hygiene 的职责），也不要删别人的 worktree 或含未推送提交的分支。
compatibility: "需要 bash 与 git；gh 可选（有 gh 才能统计未关闭 PR）；需要网络才能删除远端分支。不需要 MCP。"
---

# Repo Wrapup · 收尾

> **架构位置**：这是 `Agent Context Architecture` 中 G14「多 agent 协作的收尾责任」的执行工具。
> **与 `repo-hygiene` 的分工**：`repo-hygiene` 管**代码 / 依赖 / 死文件**；
> 本 skill 只管**分支 / worktree / PR**。两件事不要混。

## 为什么需要它

多 agent 并行时，每个 agent 只看到自己的任务范围。如果都「做完就走」，
分支和 worktree 会累积成噪音——**下一次谁都不敢删，因为分不清哪些是活的、哪些是死的。**

结果就是人每次都要多问一句：「本地和远端干净了吗？分支清了吗？worktree 清了吗？」
**这句问话本身就是流程失败的证据。**

本 skill 的作用：**把答案放进交付物**，而不是等人来问。

## Control flow

1. **AUDIT** — 跑 `scripts/audit_cleanliness.sh <repo>`，拿到六个数字。
2. **DIAGNOSE** — 逐个看：哪些是我这次留下的、哪些是别人的、哪些不能碰。
3. **PLAN** — 跑 `scripts/safe_cleanup.sh <repo>`（**默认只出计划，不改动**），确认候选清单。
4. **HUMAN APPROVAL** — 删除前向用户展示计划并取得同意。
   **例外**：用户已明确说「清理吧 / 删掉吧」时，可直接执行 `--clean`。
5. **EXECUTE** — `scripts/safe_cleanup.sh <repo> origin/main --clean`。
6. **VERIFY** — 复跑 `audit_cleanliness.sh`，确认数字归零。
7. **REPORT** — 输出「收尾报告」（见下），贴进交付物。

## 「干净」的定义（六个数字）

| 指标 | 含义 | 干净 |
|---|---|---|
| `EXTRA_WORKTREES` | 主工作区之外的 worktree | 0 |
| `LOCAL_MERGED_NOT_DELETED` | 已确认合并但本地还在的分支 | 0 |
| `REMOTE_MERGED_NOT_DELETED` | 已确认合并但远端还在的分支 | 0 |
| `BRANCHES_WITH_UNPUSHED` | 含未推送提交的分支 | 0 |
| **`UNKNOWN`** | **判不了的分支**（既非已合并、也非未推送、也无 open PR） | **0** |
| `OPEN_PRS` | 未关闭的 PR | 0（或全部在等合并且未超 3 天） |
| `UNCOMMITTED_CHANGES` | 未提交改动 | 0 |

`CLEAN=yes` 当且仅当**全部为 0（含 UNKNOWN）**且无未提交改动。

> ⚠️ **「已合并」是双判据**：base 的祖先 **或** 对应 PR 状态为 `MERGED`。
> 因为 **`git branch --merged` 看不见 squash 合并**——squash 重写了提交，
> 分支 HEAD 不再是 base 的祖先。只看祖先关系会**系统性漏报，且表现为「报告说干净」**。

## 安全边界（先看这段再动手）

`safe_cleanup.sh` 只删**同时满足全部条件**的分支：

1. 已确认合并（双判据）
2. 无未推送提交
3. **没有 open PR**
4. 不是当前分支 / main / master
5. 没有被任何 worktree 占用

**任一不满足 → 跳过，只报告。**详见 [references/safety-contract.md](references/safety-contract.md)。

> **判不了的一律进 `UNKNOWN`，只报告不删。**
> **沉默的零 ≠ 确认的零**——工具看不到的东西必须显式出现，不得因为「我没有依据」就当「没有」。
>
> ⚠️ **worktree 一律不自动删除。**它可能正被另一个 agent 使用，误删不可逆。

## 收尾报告（交付时必须附）

```markdown
## 收尾报告

| 指标 | 清理前 | 清理后 |
|---|---|---|
| 额外 worktree | 1 | 1（未删，见备注） |
| 已合并未删（本地） | 26 | 0 |
| 已合并未删（远端） | 29 | 0 |
| 含未推送提交 | 0 | 0 |
| 未关闭 PR | 0 | 0 |
| 未提交改动 | 0 | 0 |

本地工作区：干净
远端工作区：干净
备注：worktree `chore/scan-workbench-entry` 未删除——需人工确认是否仍在使用。
```

**没有这张表，就不算交付完成。**

## 命令速查

```bash
# 体检（只读）
bash scripts/audit_cleanliness.sh /path/to/repo

# 出计划（只读，默认）
bash scripts/safe_cleanup.sh /path/to/repo

# 真删（需用户授权）
bash scripts/safe_cleanup.sh /path/to/repo origin/main --clean
```

## 不做的事

| ❌ | 为什么 |
|---|---|
| 清理代码 / 依赖 / 死文件 | 那是 `repo-hygiene` |
| 删别人的 worktree / 分支 | 不是你的收尾范围 |
| 删含未推送提交的分支 | 会丢工作 |
| 自动 `git worktree remove` | 可能正在被别的 agent 使用 |
