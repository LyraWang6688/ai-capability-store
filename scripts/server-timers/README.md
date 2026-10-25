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
│   ├── repo-discoverability.service / .timer
│   └── feishu-digest.service / .timer
└── deliver/                ← 投递脚本（装到 /srv/dsh-jobs/scripts，dshjobs 身份）
    ├── inbox-deliver           ← 投递契约的唯一实现（写「任务收件箱」）
    ├── ops-audit-inbox.py / deepseek-invoice-inbox.py
    └── feishu-digest.py        ← 每天总结飞书桥上的新对话（见下节）
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
| `feishu-digest` | 每天 22:00 | 本机脚本（读桥会话库 + dsh headless）| dshjobs | **直接投递**收件箱（无内容则静默）|

> 「未接收件箱」的 8 个任务，下一步按同样模式加 `xxx-inbox.service/.timer` 即可。

## `feishu-digest`：把「我和 AI 的对话」每天总结进收件箱

**为什么在服务器上跑**：定时器如果在桌面机上，关机就白搭。放在服务器上，
桌面端只是消费端 —— 没开机只意味着「今天面板不弹」，未读记录会一直等着。

```text
桥会话库（~/.dsh/sessions/--srv-dsh-jobs-work--/session-*/session.v4.jsonl.zstd）
  │  增量提取：水位 = 每个 session 已处理到哪个事件的 seq
  ▼
dsh headless（服务器本机，模型 Key 来自 /srv/dsh-jobs/env/app.env）
  │  摘要 ≤300 字（收件箱「结果摘要」字段上限）
  ▼
inbox-deliver → 飞书「任务收件箱」（结果=成功 / 状态=未读）
  ▼
DSH 打开 → 📥 面板自动弹出未读 → 点开标已读
```

行为约定：

| 情况 | 行为 |
|---|---|
| 没有新对话 | 不写表、不发消息，退出码 0（不打扰）|
| 有新对话 | 写一条 `结果=成功`，摘要为当日总结 |
| 总结失败 | 写一条 `结果=失败`，**不推进水位**（第二天重试，宁可重复不丢）|
| 投递失败 | 非零退出（systemd 记为失败，`journalctl -u feishu-digest` 可查），不推进水位 |

手动验证 / 调试（`--dry-run` 不写表、不动水位）：

```bash
sudo -u dshjobs env HOME=/srv/dsh-jobs \
  /srv/dsh-jobs/scripts/feishu-digest.py --dry-run --all      # 全部历史对话
sudo -u dshjobs env HOME=/srv/dsh-jobs \
  /srv/dsh-jobs/scripts/feishu-digest.py --dry-run            # 只按水位增量
```

水位文件：`/srv/dsh-jobs/state/feishu-digest.json`；日志：`/srv/dsh-jobs/logs/feishu-digest.log`。

> 摘要源为什么不是桥的审计日志：审计只记用户指令全文，AI 的回答只记字数。
> 完整对话只在 DSH 会话库里，所以这里解压 `session.v4.jsonl.zstd` 读事件流。

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
