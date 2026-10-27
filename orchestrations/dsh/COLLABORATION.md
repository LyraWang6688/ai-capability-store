# DSH 定时任务：两侧协作方案与投递契约

> 这份是**协作方案**，不是目录说明，也不是插件文档。
> 读者：同时推进这件事的两个 agent（或两个人）。
>  - **DSH 侧**：维护收件箱插件、服务器运行时、投递通道；
>  - **任务侧**：维护每条定时任务本身（GitHub Actions workflow / 服务器脚本）。
>
> 目标：服务器执行的定时任务，结果自动出现在 DSH 面板的「待读」里。
> 输出段落在编排层的定义见 [`README.md`](./README.md)；实现见
> [`external-capabilities/plugin/dsh/inbox/`](../../external-capabilities/plugin/dsh/inbox/README.md)。

---
## 一、谁负责什么

| 区域 | DSH 侧 | 任务侧 |
|---|---|---|
| 收件箱插件（Host 路由 / 面板 UI）| ✅ 全部 | ❌ 不碰 |
| 飞书「任务收件箱」表结构与权限 | ✅ 建表、字段、写库凭据 | ❌ 只按契约投递 |
| 服务器环境（`dshjobs` 用户、Node、DSH、systemd、runner）| ✅ 安装与维护 | ❌ 不装不改 |
| **投递通道**（CLI / HTTP 接口、飞书凭据）| ✅ 提供并保证可用 | ✅ 在任务末尾**调用** |
| 每个任务的实现（workflow / 脚本 / skill）| ❌ 不写 | ✅ 自己维护 |
| 结果内容（摘要写什么、成功/失败判定）| ❌ 不判断 | ✅ 自己决定 |
| 任务名 → 关联任务 record_id | ✅ 提供对照表 | ✅ 调用时带上 |
| 验收 | ✅ 面板能看到、点开已读 | ✅ 任务结束确实调用投递 |

**一句话**：DSH 侧负责"最后一公里"，任务侧负责"把活干完并交件"。

---

## 二、投递契约（任务侧唯一要做的对接）

任务结束（成功、失败、超时都算）后调用一次投递：

| 字段 | 必填 | 说明 |
|---|---|---|
| `taskName` | ✅ | 与「定时任务」表的任务名一致（DSH 侧据此映射 record_id）|
| `result` | ✅ | `成功` / `失败` / `超时` |
| `summary` | ✅ | 一句话结论，≤100 字（面板上显示的就是它）|
| `executedAt` | ❌ | 执行时间（毫秒时间戳）；缺省用投递时刻 |
| `detailUrl` | ❌ | 详情链接（报告/日志/issue）；面板可点开 |

### 调用方式（按部署方式二选一）

**A. 任务跑在服务器（self-hosted runner / 本机脚本）——推荐**

```bash
inbox-deliver --task ops-audit --result 成功 --summary "磁盘 78%，2 个证书 7 天内到期" \
  --detail "/var/lib/ops-audit/reports/2026-10-23.html"
```

> `inbox-deliver` 由 DSH 侧提供（放在 `/srv/dsh-jobs/scripts/`），内部用
> `dshjobs` 环境的 `lark-cli` 写表——**任务侧不需要飞书凭据**。

**B. 任务跑在别处（GitHub Actions 云 runner）**

```bash
curl -X POST "http://<服务器>:<端口>/plugins/inbox/deliver" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <投递 token>" \
  -d '{"taskName":"repo-baseline-audit","result":"成功","summary":"12 个仓库，3 项不合格"}'
```

> 需要 DSH 侧开通端口与 token；默认不开启公网，优先用方案 A。

### 失败也要投递

`result=失败` + `summary` 写清失败原因（≤100 字）。**不要静默失败**——否则面板上永远不出现这条任务，等于断链。

---

## 三、任务侧明确"不要做"的三件事

| 不要 | 原因 |
|---|---|
| 不要改收件箱插件 / 面板 | 需要 DSH 插件知识，且会与 DSH 侧冲突 |
| 不要自己调飞书 API 写表 | 凭据只存在于 `dshjobs` 环境；多处实现会漂移 |
| 不要动 `/srv/dsh-jobs/` 目录 | 隔离设计（权限 700），只可通过 `inbox-deliver` 使用 |

---

## 四、9 个目标任务的归属与状态

| 任务 | 执行环境 | 谁加投递 | 状态 |
|---|---|---|---|
| `ops-audit` | 服务器 | DSH 侧（服务器脚本）| P1 待做 |
| `deepseek-invoice` | 服务器 | DSH 侧 | P1 待做 |
| `github-portfolio-snapshot` | GitHub Actions | 任务侧 | P2 |
| `repo-baseline-audit` | GitHub Actions | 任务侧 | P2 |
| `frontier-watch` | GitHub Actions | 任务侧 | P2 |
| `chrome-frequent-pages` | 本机 CLI | DSH 侧 | P2 |
| `repo-discoverability` | GitHub Actions | 任务侧 | P2 |
| `github-trending-daily` | GitHub Actions | 任务侧 | P3（事件消费）|
| `github-trending-weekly` | GitHub Actions | 任务侧 | P3 |

不在 DSH 的两个（维持现状）：`investdesk-quote-sync`（豆包工作）、`box2bitable-observability`（飞书机器人私聊）。

---

## 五、验收清单（任一侧完成后自测）

- [ ] 任务结束时确实调用了投递（日志里能看到调用）
- [ ] 飞书「任务收件箱」新增一行，`状态=未读`、`结果` 正确、`摘要` ≤100 字
- [ ] 该行 `关联任务` 指向「定时任务」表对应记录
- [ ] 打开 DSH，面板出现该条"待读"；点开后飞书表变「已读」

---

## 六、当前阻塞（需要人提供）

- [ ] Runner Token（`ai-capability-store` self-hosted runner）
- [ ] 飞书应用 `cli_aa1c820068f85cb6` 的 secret 配到服务器 + `base:record:*` 权限 + Base 协作者
- [ ] `DEEPSEEK_API_KEY` 写入 `/srv/dsh-jobs/env/app.env`

> 跟踪 issue：https://github.com/LyraWang6688/ai-capability-store/issues/295
