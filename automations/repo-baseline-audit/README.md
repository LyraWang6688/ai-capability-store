# repo-baseline-audit

**每周一自动体检你名下所有 GitHub 仓库的「公开项目基线」——公开 + 私有，默认跳过已归档与 fork。**

审计 17 项（安全 / 合并纪律 / CI / 可维护 / 可扩展），每项给 PASS / FAIL / UNKNOWN，
结果写入飞书 Base「仓库基线体检」表：一行一个仓库（PASS/FAIL/UNKNOWN 计数 + 不合格项清单）。

## 为什么是 Automation

触发由时钟决定（每周一 09:00 北京时间），不需要人参与；报告只做记录，**不改任何仓库设置**。

## 输出

飞书 Base「仓库基线体检」表：

| 仓库 | 可见性 | 检查日期 | PASS | FAIL | UNKNOWN | 不合格项 |
|---|---|---|---|---|---|
| LyraWang6688/xxx | 公开 | 2026-11-01 | 12 | 5 | 0 | A2 推送保护；B3 required status checks |

## 周报（DSH 会话）

本机 DSH 定时任务每周一 11:00 调用 `report.py`，读取飞书表里最近 7 天的结果并在会话里生成周报：

```bash
python3 report.py --days 7
```

## 运行

```bash
# 本地 dry-run（不写表）
DRY_RUN=1 python3 run_audit.py --owner LyraWang6688 --limit 3

# 写表（需要环境变量）
FEISHU_APP_ID=... FEISHU_APP_SECRET=... \
BASELINE_CONFIG_JSON='{"base_token":"...","table_id":"..."}' \
GH_TOKEN=... python3 run_audit.py --owner LyraWang6688
```

## Secrets（GitHub Actions）

| Secret | 用途 |
|---|---|
| `GH_AUDIT_TOKEN` | 有 admin 读权限的 PAT（读分支保护/安全设置；用 GITHUB_TOKEN 会大量 UNKNOWN） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用身份（需是该 Base 的可编辑协作者） |
| `BASELINE_CONFIG_JSON` | `{"base_token":"...","table_id":"..."}` |

## 跳过已归档 / fork

已归档仓库是"主动冻结"的，审计它们只会产生大量无意义 FAIL；fork 同理。
默认跳过，需要时显式纳入：

```bash
python3 run_audit.py --owner X --include-archived --include-forks
```

## 已知边界

- 私有仓库照常审计；但 GitHub Advanced Security 相关能力（密钥扫描/CodeQL 等）在私有仓库需要付费，
  查不到时会显示 **UNKNOWN**，不是"没开"；
- 但 `--public-only` 可只看公开仓库；
- `UNKNOWN` 表示"查不到"，不代表没开；
- 本自动化**只审计不改设置**；要改请人工按报告操作（注意：没 CI 的仓库不要开 required check）。
