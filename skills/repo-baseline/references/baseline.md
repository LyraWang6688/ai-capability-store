# 基线判据 · 17 项

> 每项写清：检查什么、怎么修、风险。

## 安全

| 项 | 检查 | 修复 | 备注 |
|---|---|---|---|
| **A1** 密钥扫描 | `security_and_analysis.secret_scanning.status == enabled` | Settings → Code security → Secret scanning | 公开仓库免费 |
| **A2** 推送保护 | `secret_scanning_push_protection.status == enabled` | Settings → Code security → Push protection | **真 Hook**：推送时就拦，绕不过 |
| **A3** Dependabot 安全更新 | `dependabot_security_updates.status == enabled` | Settings → Code security | 和「告警」是两个开关 |
| **A5** CodeQL | `code-scanning/default-setup.state == configured` | Settings → Code security → Code scanning → Default setup | **Default setup 不生成 workflow 文件**，只翻 `.github/` 会误判 |
| **A6** SECURITY.md | 根目录或 `.github/` 存在 | 新建，说明漏洞报告渠道 | — |
| **A7** Actions 权限只读 | `actions/permissions/workflow.default_workflow_permissions == read` | Settings → Actions → Workflow permissions | 防止 workflow 被利用时拥有写权限 |

## 合并纪律

| 项 | 检查 | 修复 | 风险 |
|---|---|---|---|
| **B1** 自动删分支 | `delete_branch_on_merge == true` | Settings → General → Automatically delete head branches | 无风险，最该先开 |
| **B2** Ruleset / 分支保护 | `rulesets` 非空，或 branch protection 存在 | Settings → Rules | 至少挡住：删 main / force push / 绕过 PR |
| **B3** required status checks | `required_status_checks.contexts` 非空 | 在 Ruleset 中绑定 | ⚠️ **仓库没有 CI 时开启会锁死合并** |
| **B4** review 或 CODEOWNERS | `required_approving_review_count >= 1` 或存在 CODEOWNERS | 二者其一 | 单人项目用 CODEOWNERS 即可 |
| **B5** auto-merge | `allow_auto_merge == true` | Settings → General | PR 过检查自动合，不用人盯 |
| **B6** 对话必须解决 | `required_conversation_resolution.enabled` | Ruleset | 未解决的评论不能合 |

## CI

| 项 | 检查 | 备注 |
|---|---|---|
| **C1** 有真实 CI | `.github/workflows/` 存在 yml | 目录存在但文件为空 / 只 checkout 不算 |

## 可维护

| 项 | 检查 | 修复 |
|---|---|---|
| **D1** PR 模板 | `.github/pull_request_template.md` 存在 | 可设「必答问题」逼人想清楚 |
| **D3** CODEOWNERS | `.github/CODEOWNERS` 或根目录 CODEOWNERS | 多 agent 场景自动指派 reviewer |

## 可扩展

| 项 | 检查 | 备注 |
|---|---|---|
| **E2** Releases + Tags | `tags` 非空 | 可回滚、可追溯 |
| **E3** Dependabot 版本更新 | `.github/dependabot.yml` 存在 | 建议分组：minor+patch 合并、major 单独、安全更新不排队 |

---

# 优先级

| 级别 | 项 | 理由 |
|---|---|---|
| **P0** | A1 A2 A3 A5 | 安全开关，改设置即可，零风险 |
| **P1** | B1 B2 B3 | 合并纪律，但 B3 需先有 CI |
| **P2** | D1 D3 B5 E2 E3 | 协作与可维护性 |

# 已发现的高频问题（2026-10 实测 10 个公开仓库）

| 问题 | 通过率 |
|---|---|
| A1 密钥扫描 | 10/10 ✅ |
| A7 Actions 只读 | 10/10 ✅ |
| A2 推送保护 | 4/10 |
| A3 Dependabot 告警 | 1/10 |
| A5 CodeQL | 1/10 |
| B1 自动删分支 | 1/10 |
| B5 auto-merge | 0/10 |

**结论：容易被漏掉的是「一键就能开」的那些**——A2/A3/A5/B1。
