# 交接：定时任务改造（DSH / AI Capability Store）

> **这是一份交接文档，但只要它的内容还成立，就该一直留在这里。**
> 过期了就改它，别另起一份。
>
> 仓库：`git@github.com:LyraWang6688/ai-capability-store.git`
> 服务器：`ssh ubuntu@43.143.239.42`（腾讯云轻量，CST 时区，`sudo` 免密）

---

# 0. 先读这些（30 分钟）

```
① 仓库根目录 AGENTS.md          ← 控制平面，规定了每个改动该去哪
② orchestrations/scheduled-task/README.md   ← 本项目的核心抽象（我刚重写过）
③ scripts/server-timers/README.md           ← 定时器怎么装
④ 这份文档（你正在读）
⑤ 飞书「定时任务」表                        ← 唯一真相（见下）
```

**飞书表**：<https://my.feishu.cn/wiki/P3qAws8yjiU4eSkJDfTcYEbJnlg>
→ 数据表 **「定时任务」**
→ `base_token = NeujbbOfcaPEvMsPIxscaJImn9d`，`table_id = tbl4k7ggY1paqoUn`
→ 字段：任务名称（主字段）· 执行周期 · 执行时间 · 具体链路 · 输入 · 处理 · 输出

**读表用这个**（`--format json` 的 `data.data` 是二维数组，顺序 = 字段创建顺序，不稳定；
`--format markdown` 有字段名但内容里的 `|` 会串列）：

```bash
lark-cli base +record-list --base-token NeujbbOfcaPEvMsPIxscaJImn9d \
  --table-id tbl4k7ggY1paqoUn --as user --format json \
  | python3 -c "import json,sys; [print(r) for r in json.load(sys.stdin)['data']['data']]"
```

---

# 1. 第一件要做的事：修漂移（⚠️ 现在就存在）

## 现状

```
/etc/cron.d/                        ← cron 真正读的，【新的，正确】
/opt/ai-capability-store/           ← git 检出，【旧的，落后 8 个 commit】
        ↓
3 个 .cron 两边不一致：
  github-trending-daily        cron.d=0 20 * * *    opt=17 5 * * *
  github-trending-weekly       cron.d=0 21 * * 0    opt=17 19 * * 0
  github-portfolio-snapshot    cron.d=0 18 1 * *    opt=17 20 1 * *
```

## 为什么会这样（别重复这个错）

```
上一个 AI 是把文件【tar 直推】到服务器 /tmp，再跑 install.sh
        ↓
跳过了服务器上的 /opt/ai-capability-store 检出
        ↓
所以检出停在 c776b7f，而 /etc/cron.d 是新的
        ↓
【两份都"有内容"，但一份新一份旧，而且都像源码】
```

## 正确做法

```bash
ssh ubuntu@43.143.239.42
cd /opt/ai-capability-store
git pull                                    # 它有只读 deploy key，能拉
sudo bash scripts/server-timers/install.sh  # 从检出装，不要从 /tmp 装
```

## 验证三方一致

```bash
ssh ubuntu@43.143.239.42 '
for n in $(ls /etc/ai-capability-store/timers/*.cron | xargs -n1 basename | sed "s/\.cron$//"); do
  a=$(grep -vE "^#|^SHELL|^PATH|^$" /etc/cron.d/$n | head -1)
  b=$(grep -vE "^#|^SHELL|^PATH|^$" /opt/ai-capability-store/scripts/server-timers/timers/$n.cron | head -1)
  [ "$a" = "$b" ] && echo "✅ $n" || echo "🔴 $n 不一致"
done'
```

再拿输出跟飞书「定时任务」表逐条对。

**仓库侧已经写了一条检查**：`validate_store.py` 会核对每个 `.cron` 里引用的
`automation-*.yml` 是否真的存在（防"名字写错 → 到点 404 没人发现"）。

---

# 2. 这套体系的抽象（重要，别再造"五段"）

**用户的定义，已经写进 `orchestrations/scheduled-task/README.md`：**

```
定时任务 = 输入 + 处理 + 输出
输出必须是【用户能在界面上看见的地方】—— 不是"写了个文件"
```

**段与段之间只有两种关系，判据是「A 能不能直接调用 B 的接口」：**

```
能   → 直连（同步、即时、请求-响应）
不能 → 桥（A 交给 C 存着，B 自己来取 —— 异步、可能没人取）
```

**⚠️ 不是「跨环境就要桥」**：

| A | B | 跨环境? | 关系 |
|---|---|---|---|
| 服务器 crontab | GitHub Actions | ✅ | **直连**（`workflow_dispatch`）|
| 本机 CLI | 飞书 Base | ✅ | **直连**（OpenAPI）|
| GitHub Actions | DSH | ✅ | **桥**（DSH 无公网入口，Actions 调不到）|

**两种失败：**

- **桥断了**：放了东西没人取（git 分支没人 pull / 关键词改了没人接）
- **缺一段**：根本没有「输出」这一段 ← **更难发现**（处理成功、日志正常、文件也写了，只是没人看）

**检查一条链的四问**：① 输入在不在 ② 处理跑不跑 ③ 输出到没到 GUI ④ 每个不能直连处的「取」端谁负责

> 之前写过一个「五段」（敲钟→执行→推事件→消费→执行 skill）—— **已经被用户否掉**，
> 因为那是 `investdesk` 这一条链的具体形状，不是模型。别再改回去。

---

# 3. 三个位置，各是什么

| 位置 | 是什么 | 怎么改 |
|---|---|---|
| **GitHub PR** | 为什么这么改的记录 | 走 PR，`main` 有分支保护 |
| **仓库 `scripts/server-timers/`** | 定时器源码（唯一源码）| 改这里 + push |
| **服务器 `/etc/ai-capability-store/timers/`** | 安装后的源 | `install.sh` 从 `/opt` 检出复制 |
| **服务器 `/etc/cron.d/`** | cron 只读这里 | 同上（复制，不是软链）|

**流程**：改仓库 → push → 服务器 `git pull && install.sh` → 验证

**⚠️ cron 只读 `/etc/cron.d/`**，源码不能住那儿 —— 所以必须有 `install.sh` 这一步。
「改了仓库但忘了跑 install.sh」是可能的，而且**不会报错**（旧时间照常工作）。

---

# 4. 11 个任务的现状

来源：飞书「定时任务」表（11 条）。

## ✅ 已闭环（5 条）

| 任务 | 输入 | 输出（GUI）|
|---|---|---|
| `investdesk-quote-sync` | 服务器 cron 工作日 20:00 | 飞书私聊：持仓日报 |
| `github-portfolio-snapshot` | 服务器 cron 每月 1 日 18:00 | 飞书 Base：Repo Snapshot History |
| `repo-baseline-audit` | 服务器 cron 周一 09:00 | 飞书 Base：仓库基线体检 |
| `frontier-watch` | 服务器 cron 周一 10:00 | 飞书：通知 + Base |
| `chrome-frequent-pages` | **本机 launchd 周一 09:30** | 飞书 Base「常用网页」|

⚠️ `chrome-frequent-pages` 的 launchd **还没装**（`~/Library/LaunchAgents/` 里没有）：
`bash external-capabilities/cli/chrome-frequent-pages/install.sh`

## 🟡 半 GUI（3 条）

| 任务 | 问题 |
|---|---|
| `github-trending-daily` | 输出到 git `data` 分支 —— **桥的取端没人**（等 DSH 去拉，现靠定时轮询）|
| `github-trending-weekly` | 同上 |
| `repo-discoverability` | 输出到 GitHub issue —— 是 GUI，但不在日常界面 |

## 🔴 没有输出（3 条）—— **最需要做**

| 任务 | 现在写到哪 | 用户怎么看 |
|---|---|---|
| `box2bitable-observability` | `/opt/box2bitable/docs/reports/*.md` | 要 SSH |
| `ops-audit` | `/var/lib/ops-audit/reports/*.html` | 要 SSH |
| `deepseek-invoice` | `/opt/deepseek-invoice/logs` | 要 SSH |

**这 3 条不是"桥断了"，是"链少了一节"** —— 触发 ✅ 处理 ✅ 然后就结束了，
"用户在哪看到"这段压根没设计。

**补法建议**：服务器 → 飞书（文件/文档/Base）。因为飞书就是用户的 GUI。

---

# 5. 建议的动手顺序

```
① 修 /opt 漂移（第 1 节）                              ← 零风险，先做
② chrome-frequent-pages 装 launchd                     ← 一条命令，装完就闭环
③ ops-audit 补飞书输出                                 ← 🔴 里最该做的
④ deepseek-invoice 补飞书输出（发票截图）
⑤ box2bitable-observability 补飞书输出
⑥ repo-discoverability 推到飞书
⑦ trending-daily / weekly 接 DSH 监听（最大一块，涉及 DSH 侧）
```

**⚠️ 用户的规矩**：合并 / 打 tag / 发布 **每次都要问**，不能自己决定。
（"没有我的命令，禁止你再上传了"）

---

# 6. 踩过的坑（别重复）

| # | 坑 | 教训 |
|---|---|---|
| 1 | 用 `tar \| ssh` 直推文件到服务器，跳过了 `git pull` | **服务器只从 GitHub 拉**，不要绕 |
| 2 | 改 nginx 配置前没查仓库有没有副本 | **改任何服务器配置前，先问"这文件在 Git 里有副本吗"** |
| 3 | `s.replace("17 5 * * *", "0 20 * * *", 1)` 命中了注释，命令行没动 | 改 `.cron` 要**整段重写**，改完 grep 验证 |
| 4 | 删 `schedule:` 用了 `^  schedule:\s*\n((?:...)*)` 正则，留下孤儿 `- cron:` | YAML 块的删除要用缩进解析，不要用正则 |
| 5 | `shutil.copytree` / `copy2` 默认**跟随软链** | fixture harness 里必须 `symlinks=True` + 先判 `islink` |
| 6 | `os.path.isfile()` 对**指向目录的软链**返回 False | 软链判断要放在 `isfile` 之前 |
| 7 | 改了 `external_trigger` 路径，验证器的「必须在 automation 自己目录下」规则挂了 | 现在允许两个位置：自己目录 或 `scripts/server-timers/timers/` |
| 8 | 在**共享工作区**跑过 `git reset --hard` / `git checkout main` | **所有 git 操作都在自己的 worktree 里做**，主工作区可能有别的 AI 在用 |

---

# 7. 顺手要处理的一件事：DSH 的 bug

**现象**：Web GUI 里助手回复在「思考 / 运行命令」之后就停了，**正文不渲染**，
但状态显示「已完成，用时 N 秒」。本轮对话里连续出现两次（03:50，37 秒 / 18 秒）。

**报告已写**：见本仓库 `docs/known-issues/dsh-final-message-not-rendered.md`

**提交渠道**：`deepseek-ai/deepseek-harness` 的 **Issues 是关闭的**，只有 **Discussions**：
<https://github.com/deepseek-ai/deepseek-harness/discussions>

**⚠️ 这个 bug 会直接影响交接**：你写的长回复可能对方看不到 ——
**重要信息用短格式、或写成文件**。

---

# 8. 环境与凭据

```
服务器：      ssh ubuntu@43.143.239.42（sudo 免密）
             /opt/box2bitable  = feishu-retail-ops 的检出（也是线上运行的目录，pm2 跑它）
             /opt/ai-capability-store = Store 的检出（只读 deploy key，能 pull 不能 push）
             /etc/ai-capability-store/github-token = 只能触发 Actions 的令牌

飞书：        lark-cli 已认证（user 身份）
             base_token = NeujbbOfcaPEvMsPIxscaJImn9d

GitHub：      gh 已认证（LyraWang6688）
             ai-capability-store 的 main 有分支保护 → 必须走 PR
```

---

# 9. 怎么确认自己没搞坏

```bash
cd ~/Documents/workplace/ai-capability-store
python3 scripts/validate_store.py            # 期望：1434 checks, 0 failures
python3 scripts/test_validator.py            # 期望：PASS (25 checks)
python3 scripts/check_tracked_hygiene.py     # 期望：no generated files are tracked
python3 skills/store-publish/scripts/check_tag_version.py --missing origin/main
```

**当前基线**：`origin/main = 3dddf91`，1434 checks，0 failures，Open PR = 0。

---

# 10. 一句话总结

> **11 个定时任务，5 个真闭环、3 个半截、3 个没输出。**
> **先把服务器 /opt 那份拉平（现在和 /etc/cron.d 不一致）。**
> **然后一个一个补输出 —— 标准是「用户能在界面上看见」。**
