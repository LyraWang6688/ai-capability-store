# 服务器定时器总目录

**所有项目的"钟"集中在这一处。** 每个项目一个 `.cron` 文件，不散落在
`/etc/cron.d/` 和各自的 crontab 里。

```text
服务器：
  /etc/ai-capability-store/
    github-token                         ← 只读代码、只触发 Actions 的令牌
    timers/                              ← 【总目录】
      investdesk-quote-sync.cron
      box2bitable-observability.cron
      README.md
  /etc/cron.d/                           ← cron 只读这里
    investdesk-quote-sync         ← 由 install.sh 从总目录复制
    box2bitable-observability     ← 同上
```

---

## 为什么要有这个总目录

### 1. 钟必须在 24 小时常驻的机器上

```text
放本机：关机就断，而且关机跨过时间点不会累积（cron 直接跳过）
放服务器：不管本机开不开，任务都准点
```

### 2. GitHub 的 schedule 是 best-effort

```text
本仓库实测延迟 4-5 小时（workflow 注释里留着 "QUEUED FOR 4h14m"）
        ↓
而消费方 09:00 就要数据
        ↓
【所以钟换成自建服务器的 crontab：workflow_dispatch 会立刻开始，不走调度队列】
```

### 3. 集中以后，两件事变得可查

```text
"这台机器上到底有哪些定时任务？"   → ls /etc/ai-capability-store/timers/
"某条链的钟在哪？"                → grep -r <项目名> /etc/ai-capability-store/timers/
```

以前答案是："`/etc/cron.d/` 里翻一遍 + 每个用户的 crontab 各看一遍 + 再想想有没有 systemd timer"。

---

## 为什么 `cron.d` 里还是复制而不是软链

**cron 只读 `/etc/cron.d/`，这一层绕不过去。** 总目录是源，`install.sh` 负责复制到
`/etc/cron.d/` —— 不用软链，因为 Debian 的 cron 会检查文件的属主与权限，软链会让
"检查的是谁"变成一个需要解释的问题。

---

## 为什么命令写在脚本里，不直接写进 cron

`crontab` 里 **未转义的 `%` 会被换成换行**，而且**第一个 `%` 之后的所有内容会作为
stdin 传给命令**。`curl -w '%{http_code}'` 正好含 `%` —— 直接写会让整行被截断成
shell 语法错误，而且是**静默失效**：cron 只在本地邮件里报错。

第一版就是这么写的，装上去之后每天 20:00 悄悄失败。

---

## 装 / 改 / 卸

```bash
# 装（幂等，可反复跑）
bash scripts/server-timers/install.sh

# 改了一个 .cron 之后
bash scripts/server-timers/install.sh
sudo systemctl reload cron     # 或 service cron reload

# 卸掉某个项目
sudo rm /etc/cron.d/<name> /etc/ai-capability-store/timers/<name>.cron
```

**`install.sh` 只复制 `.cron` 文件**，脚本本身（`dispatch.sh` 等）装到
`/usr/local/bin/`，两者分开 —— 改时间不用重装脚本，改脚本不用动时间。

---

## 清单

| 项目 | 文件 | 它做什么 | 谁执行 | 时间（北京）|
|---|---|---|---|---|
| investdesk | `investdesk-quote-sync.cron` | 敲 GitHub Actions（持仓价格同步）| root | 工作日 20:00 |
| box2bitable | `box2bitable-observability.cron` | 在服务器本机跑观测日报 | ubuntu | 每天 09:00 |
| github-trending | `github-trending-daily.cron` | 敲 GitHub Actions（日报）| root | 每天 20:00 |
| github-trending | `github-trending-weekly.cron` | 敲 GitHub Actions（周报）| root | 周日 21:00 |
| github-portfolio | `github-portfolio-snapshot.cron` | 敲 GitHub Actions（作品集快照）| root | 每月 1 日 18:00 |
| repo-health | `repo-discoverability.cron` | 敲 GitHub Actions（发现性体检）| root | 周一 20:00 |
| repo-health | `repo-baseline-audit.cron` | 敲 GitHub Actions（基线体检）| root | 周一 09:00 |
| frontier | `frontier-watch.cron` | 敲 GitHub Actions（前沿观察）| root | 周一 10:00 |

### 时间以飞书表为准

**「什么时候跑」这件事，唯一真相在飞书**：

> [项目管理](https://my.feishu.cn/wiki/&lt;wiki-token&gt;) → 数据表 **「定时任务」**
> 字段：任务名称（主字段）· 执行周期 · 执行时间 · 具体链路
>
> wiki / base / table 标识是内部坐标，不入库；下面命令里的两个变量从本地环境取。

改时间改表，然后同步到这里：

```bash
lark-cli base +record-list --base-token "$TIMER_BASE_TOKEN" \
  --table-id "$TIMER_TABLE_ID" --as user --format json \
  | python3 -c "import json,sys; [print(r[0], r[3]) for r in json.load(sys.stdin)['data']['data']]"
# 然后改对应的 .cron，跑 install.sh
```

**为什么不在代码里当真相**：改一个时间要动 4 个地方（`.cron`、两个 README、注册表），
而表是你能直接打开看的地方。代码这边只保证「和表一致」。

### 历史：迁过来时修掉过一个 8 小时偏差

原来这 3 个 workflow 写的是 GitHub 的 **UTC** cron，注释却把它们当成北京时间：

```text
17 5 * * *    (UTC)   注释以为 05:17 Asia/Shanghai   实际 13:17 北京
17 19 * * 0   (UTC)   注释以为 19:17 Asia/Shanghai   实际 次日 03:17 北京
17 20 1 * *   (UTC)   注释以为 20:17 Asia/Shanghai   实际 次日 04:17 北京
```

`github-trending-daily` 的注释明确写着它要「在 09:00 的 DSH 消费任务前 3h45m 跑完」——
而 13:17 已经晚于 09:00。**这份日报一直比预期晚 8 小时。**

搬进服务器后时间由我们自己的 crontab 控制；2026-10-22 王颖在飞书表里重新定了时间
（日报 20:00 / 周报周日 21:00 / 快照 18:00），代码按表同步。

### 一条检查防"名字写错"

`validate_store.py` 会核对每个 `.cron` 里引用的 `automation-*.yml` 是否真的存在于
`.github/workflows/`。为什么需要它：`.cron` 只是给 cron 读的文本，名字写错不会报错 ——
cron 照常到点执行、脚本照常 POST、GitHub 返回 404，而那行日志没人看。

**一个永远不会成功的定时器，看起来和正常的一模一样。**
