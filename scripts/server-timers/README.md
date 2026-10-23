# 服务器定时任务总目录

**所有项目的"钟"集中在这一处，且只有一个形式：systemd timer。**

```text
scripts/server-timers/
├── install.sh              ← 唯一安装入口（sudo bash install.sh）
├── dispatch.sh             ← 触发 GitHub Actions 的脚本（装到 /usr/local/bin）
├── systemd/                ← 全部触发器：每个任务一组 .service + .timer
│   ├── ops-audit.service / .timer
│   ├── ops-audit-inbox.service / .timer
│   ├── deepseek-invoice.service / .timer
│   ├── deepseek-invoice-inbox.service / .timer
│   ├── box2bitable-observability.service / .timer
│   ├── frontier-watch.service / .timer
│   ├── github-portfolio-snapshot.service / .timer
│   ├── github-trending-daily.service / .timer
│   ├── github-trending-weekly.service / .timer
│   ├── investdesk-quote-sync.service / .timer
│   ├── repo-baseline-audit.service / .timer
│   └── repo-discoverability.service / .timer
└── deliver/                ← 投递脚本（装到 /srv/dsh-jobs/scripts，dshjobs 身份）
```

## 规则（2026-10-24 定）

| 规则 | 内容 |
|---|---|
| 触发器形式 | **一律 systemd timer**，不再新增 crontab / `/etc/cron.d` |
| 触发器位置 | 全部在 `scripts/server-timers/systemd/` |
| 安装入口 | 只有一个：`sudo bash install.sh` |
| 投递脚本 | `deliver/*` → `/srv/dsh-jobs/scripts/`（`dshjobs` 身份，只它持有飞书凭据）|
| 旧 cron | 已全部迁移；`install.sh` 会删除 `/etc/cron.d` 里的同名旧文件 |

## 为什么从 cron 换成 systemd timer

- `Persistent=true`：服务器重启/维护错过时间点会补跑（钱账类任务不能丢）
- `After=`：投递等执行结束，不用 `sleep`
- `User=dshjobs` + `EnvironmentFile`：凭据隔离
- `journalctl -u`：日志按单元聚集
- `RandomizedDelaySec`：多个任务错峰
- `systemctl list-timers`：一眼看全部下次触发时间

## 当前触发器

| 任务 | 时间 | 形式 | 执行身份 | 结果去向 |
|---|---|---|---|---|
| `ops-audit` | 每月 1 日 21:00 | 本机脚本 | ubuntu | 报告 → **执行结束即投递**收件箱 |
| `deepseek-invoice` | 每月 1 日 10:00 | 本机浏览器自动化 | ubuntu | 日志 → **执行结束即投递**收件箱 |
| `box2bitable-observability` | 每天 09:00 | 本机 node 脚本 | ubuntu | 报告文件（未接收件箱）|
| `frontier-watch` | 每周一 10:00 | 敲 Actions | root | Actions 结果（未接收件箱）|
| `github-portfolio-snapshot` | 每月 1 日 18:00 | 敲 Actions | root | 同上 |
| `github-trending-daily` | 每天 20:00 | 敲 Actions | root | 同上 |
| `github-trending-weekly` | 每周日 21:00 | 敲 Actions | root | 同上 |
| `investdesk-quote-sync` | 周一至周五 20:00 | 敲 Actions | root | 同上 |
| `repo-baseline-audit` | 每周一 09:00 | 敲 Actions | root | 同上 |
| `repo-discoverability` | 每周一 20:00 | 敲 Actions | root | 同上 |

> 「未接收件箱」的 8 个任务，下一步按同样模式加 `xxx-inbox.service/.timer` 即可。

## 新增一个任务的步骤

1. `systemd/` 加 `xxx.service` + `xxx.timer`（`Unit=xxx.service`，`Persistent=true`）
2. 若结果要进 DSH：`deliver/xxx-inbox.py`（读结果 → 调 `inbox-deliver`）
3. `systemd/` 加 `xxx-inbox.service` + `xxx-inbox.timer`（`User=dshjobs`，`After=xxx.service`）
4. `sudo bash install.sh`
5. `systemctl list-timers --all | grep xxx` 确认

## 常用命令

```bash
systemctl list-timers --all | grep -E 'ops-audit|deepseek-invoice'
systemctl start ops-audit-inbox.service           # 立即投递一次
journalctl -u deepseek-invoice.service -n 50      # 看执行日志
journalctl -u deepseek-invoice-inbox.service -n 50
```

## 依赖（服务器上需先准备）

| 依赖 | 用途 |
|---|---|
| `/etc/ai-capability-store/github-token` | dispatch 敲 Actions 用 |
| `dshjobs` 的 lark-cli 配置（`/srv/dsh-jobs`）| 投递写飞书表 |
| `/srv/dsh-jobs/env/app.env`（可选）| 覆盖 `DSH_INBOX_*` 等环境变量 |


## 投递时机（2026-10-24 调整）

执行单元加了：

```ini
[Unit]
OnSuccess=ops-audit-inbox.service
OnFailure=ops-audit-inbox.service
```

任务一结束（成功或失败）立刻触发投递，不再靠固定 offset 猜时间。
投递脚本有「同一天只投一次」的幂等保护（`/srv/dsh-jobs/state/<task>.delivered`），
手动重跑任务不会重复写收件箱；`--force` 可强制再投。

## 服务器如何更新（从 GitHub 拉，不从 Mac 推）

```bash
# 服务器上（root）
sudo bash /srv/dsh-jobs/scripts/pull-store.sh
```

脚本会：

1. 用 GitHub API 查 `main` 最新 commit；
2. 与 `/srv/dsh-jobs/work/store-src/.last-commit` 比对，相同则退出；
3. 不同则从 `codeload.github.com` 下载 tarball（失败回退 `api.github.com`）；
4. 解包后执行 `scripts/server-timers/install.sh`；
5. 记录新 commit。

> 为什么不是 `git clone`：这台服务器访问 `github.com` 不通（实测 curl 000），
> `api.github.com` 与 `codeload.github.com` 可通。tarball 拉取效果等同拉仓库，且不需要 git 凭据。
