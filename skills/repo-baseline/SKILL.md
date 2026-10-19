---
name: repo-baseline
description: 审计 GitHub 公开仓库是否满足「公开项目基线」（安全 / 合并纪律 / CI / 可维护 / 可扩展），逐项给出 PASS/FAIL 与修复指引，并可批量扫描一个账号下的所有公开仓库。当新开项目、定期体检仓库、用户问「仓库配置合格吗 / 该开哪些 GitHub 功能 / 白嫖 GitHub 哪些能力」时使用；也可在接手一个陌生仓库前先建立它的安全与协作基线。不要用它清理分支或代码（那分别是 repo-wrapup 和 repo-hygiene），也不要对私有仓库套用（部分安全功能需付费）。
compatibility: "需要 gh CLI 且已登录；需要网络。不需要 MCP。私有仓库会被跳过（Advanced Security 需付费）。"
---

# Repo Baseline · 公开项目基线

> **前提**：公开仓库 → GitHub 的付费级安全能力**几乎全免费**
> （Actions 分钟数无限、CodeQL、Secret scanning、Dependabot）。
> 所以「白嫖」不是将就，是把已经买到的用起来。

## 它检查什么（17 项，五组）

| 组 | 项 |
|---|---|
| **安全** | 密钥扫描 · 推送保护 · Dependabot 安全更新 · CodeQL · SECURITY.md · Actions 权限只读 |
| **合并纪律** | 自动删分支 · Ruleset/分支保护 · required status checks · review 或 CODEOWNERS · auto-merge · 对话必须解决 |
| **CI** | 有真实 CI workflow |
| **可维护** | PR 模板 · CODEOWNERS |
| **可扩展** | Releases+Tags · Dependabot 版本更新配置 |

完整判据与修复方式见 [references/baseline.md](references/baseline.md)。

## Control flow

1. **AUDIT** — 跑 `scripts/audit_baseline.py <owner/repo>`。
   批量：`scripts/audit_baseline.py --all --owner <owner>`。
2. **READ** — 对每个 ✗，先读它给的修复提示；**不要盲改**。
3. **PRIORITIZE** — 按影响排序，不要一次全开：
   - **P0**：A1–A3、A5（安全开关，改设置即可，零风险）
   - **P1**：B1（自动删分支）、B2/B3（分支保护 + required check）
   - **P2**：模板类（D1/D3）、auto-merge（B5）
4. **WARN** — **打开 required check 之前，必须先确认仓库已有能通过的 CI**。
   否则会**锁死合并**，PR 永远合不了。这是本 skill 最容易造成事故的地方。
5. **REPORT** — 输出建议清单：按仓库分组，每项写「开什么 / 为什么 / 风险」。
6. **APPLY（需用户明确同意）** — 改仓库设置属于写操作，**必须取得授权**。
   本 skill 默认只审计，不改任何设置。

## 输出示例

```
[安全]
  ✓ A1  密钥扫描 secret scanning
  ✗ A2  推送保护 push protection
        → Settings → Code security → Push protection（真 Hook，服务端拦截）
...
未关闭 CodeQL 告警: 30
得分: 12/17
```

## 最容易出事的点

| 坑 | 后果 | 正确做法 |
|---|---|---|
| 给**没有 CI** 的仓库开 required check | **合并被锁死** | 先建 CI，再开 check |
| 把「CodeQL 未启用」判错 | 漏判 | CodeQL 的 **Default setup 不生成 workflow 文件**，必须查 `code-scanning/default-setup` 接口 |
| 只看 `.github/workflows/` | 以为所有功能都没开 | 功能状态要查**状态接口**，不是查配置文件 |
| 开了扫描就以为安全 | 告警堆积无人看 | **扫描是发现，triage 才是安全** |

## 不做的事

| ❌ | 为什么 |
|---|---|
| 清理分支 / worktree | 那是 `repo-wrapup` |
| 清理代码 / 依赖 / 死文件 | 那是 `repo-hygiene` |
| 默认修改仓库设置 | 改设置是写操作，需用户授权 |
| 对私有仓库套用全套基线 | 部分安全功能需付费，会产生假失败 |

## 命令

```bash
# 单个仓库
python3 scripts/audit_baseline.py LyraWang6688/feishu-retail-ops

# 全部公开仓库 + 汇总
python3 scripts/audit_baseline.py --all --owner LyraWang6688
```

退出码：0 = 全部 PASS（或跳过）；1 = 存在 FAIL。
