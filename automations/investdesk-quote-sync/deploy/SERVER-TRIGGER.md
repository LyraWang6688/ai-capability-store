# Server trigger — 让这个 automation 准点跑

> **⚠️ 2026-10-22 起，钟已迁到 `scripts/server-timers/`。**
>
> 本目录里的 `server-trigger.sh` / `server-trigger.cron` 是**历史记录**，服务器上已不再使用：
>
> ```text
> 旧：/usr/local/bin/investdesk-quote-sync-trigger  +  /etc/cron.d/investdesk-quote-sync
> 新：/usr/local/bin/ai-capability-store-dispatch   +  /etc/ai-capability-store/timers/*.cron
> ```
>
> 服务器上所有项目的钟现在集中在一个目录里（`ls /etc/ai-capability-store/timers/`），
> 安装与运维见 [`scripts/server-timers/README.md`](../../../scripts/server-timers/README.md)。
>
> **下面这份文档保留下来，是因为它解释了"为什么不能用 GitHub 的 schedule"、
> "为什么服务器只需要一个只读令牌"、"为什么命令不能直接写进 crontab"——
> 那三条推理现在仍然成立，只是安装位置变了。**



## 为什么需要它

这个 automation 由 GitHub Actions 执行，但**不再由 GitHub 的定时器触发**。

```text
GitHub 的 schedule 是 best-effort
        ↓
本仓库实测延迟 4-5 小时（workflow 里曾有注释记着 "QUEUED FOR 4h14m"）
        ↓
计划 20:00 跑，实际可能到次日 01:00
        ↓
而它必须赶在次日 09:00 的消费方之前落地
```

改法：**用自建服务器的 crontab 准点调 `workflow_dispatch`** —— 手动触发的 run 会立刻开始，不走调度队列。任务的执行、凭据、日志、历史仍然全在 GitHub 上，只是"钟"换了个准的。

```text
服务器 crontab（准点）
   → POST /actions/workflows/<wf>/dispatches
   → GitHub 立刻创建 run
   → 在 GitHub 的 runner 上执行（凭据仍是 GitHub Secrets）
```

## 服务器上不需要本项目

只发一个 HTTP 请求。服务器需要的东西：

| 需要 | 不需要 |
|---|---|
| `curl`（基本都预装）| 本项目代码 |
| 一个 GitHub 令牌 | Node.js / 依赖 |
| 一条 crontab | 飞书、万得的凭据 |

## 一、造令牌

```text
https://github.com/settings/personal-access-tokens/new

Token name:          investdesk-quote-sync-trigger
Repository access:   Only select repositories → ai-capability-store
Permissions:         Repository permissions → Actions: Read and write   ← 只需这一项
```

**最小权限**：这个令牌只能触发 Actions，读不了代码、推不了东西。泄漏的损害面很小。

## 二、装令牌文件（600）

```bash
sudo mkdir -p /etc/ai-capability-store
sudo tee /etc/ai-capability-store/github-token >/dev/null   # 粘令牌 → Ctrl-D
sudo chmod 600 /etc/ai-capability-store/github-token
sudo chown root:root /etc/ai-capability-store/github-token

# 验证不是空的
sudo wc -c /etc/ai-capability-store/github-token
sudo head -c 13 /etc/ai-capability-store/github-token; echo   # github_pat_ 或 ghp_
```

## 三、装脚本

```bash
sudo cp server-trigger.sh /usr/local/bin/investdesk-quote-sync-trigger
sudo chmod 700 /usr/local/bin/investdesk-quote-sync-trigger
```

（如果服务器上没有本项目，直接用 `curl` 拉：`https://raw.githubusercontent.com/LyraWang6688/ai-capability-store/main/automations/investdesk-quote-sync/deploy/server-trigger.sh`）

## 四、手测 —— **必须看到退出码 0 再装 cron**

```bash
sudo /usr/local/bin/investdesk-quote-sync-trigger; echo "退出码=$?"
sudo tail -2 /var/log/investdesk-quote-sync-trigger.log
```

期望：`... OK dispatched (204)`

| 状态 | 含义 | 处理 |
|---|---|---|
| `204` | 成功 | 装 cron |
| `401` | 令牌无效/过期 | 重造令牌 |
| `403` | 令牌无此仓库权限 | 检查 Repository access |
| `404` | 令牌看不到 Actions | 补 **Actions: Read and write** |

**同时去 GitHub 确认真的跑了**（两边时间戳应该到秒级一致）：

```bash
gh run list --repo LyraWang6688/ai-capability-store \
  --workflow automation-investdesk-quote-sync.yml --limit 3
```

## 五、装 cron

**先算小时** —— 别手算，用这台机器自己的时区：

```bash
EPOCH=$(TZ=Asia/Shanghai date -d 'today 20:00' +%s)
echo "北京 20:00 → 本机小时 = $(date -d "@$EPOCH" +%H) （本机 $(date +%Z%z)）"
```

然后把 `server-trigger.cron` 里的 `{{HOUR}}` 换成上面算出的小时：

```bash
sudo tee /etc/cron.d/investdesk-quote-sync >/dev/null <<CRON
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
# 北京 20:00 周一至周五。本机 $(date +%Z) 下小时=20。
0 20 * * 1-5 root /usr/local/bin/investdesk-quote-sync-trigger
CRON
sudo chmod 644 /etc/cron.d/investdesk-quote-sync
sudo systemctl is-active cron
```

> ⚠️ 上面注释里那句"为什么命令不是在 crontab 里直接写 curl"不能省 —— 见 `server-trigger.cron` 顶部。

## 六、验证：次日 20:00 之后

```bash
gh run list --repo LyraWang6688/ai-capability-store \
  --workflow automation-investdesk-quote-sync.yml --limit 3 \
  --json event,conclusion,createdAt \
  -q '.[] | "\(.createdAt) \(.event) \(.conclusion)"'
```

期望：`workflow_dispatch` + `success`，时间就在 12:00Z 附近。**现在不应该再有 `schedule` 的 run** —— 那个触发源已经从 workflow 里移除了。

## 运维

```bash
# 最近几次
sudo tail -20 /var/log/investdesk-quote-sync-trigger.log

# 令牌过期了会看到
#   FAIL http=401 ... body={"message":"Bad credentials",...}

# 换令牌
sudo tee /etc/ai-capability-store/github-token >/dev/null   # 粘新的 → Ctrl-D
```

## 代价（写给未来的自己）

**移除 workflow 里的 `schedule` 意味着没有兜底**：服务器挂了、令牌过期了，当天就不会跑。

如果这个风险变得不能接受，加回一段**低频** schedule 即可（比如每周一次）：

```yaml
on:
  schedule:
    - cron: '0 6 * * 1'      # 每周一 06:00 UTC，只做一次幂等写入
  workflow_dispatch:
```

它只会重复写一次同样的价格，不会造成问题；而服务器正常时那条根本不需要。
