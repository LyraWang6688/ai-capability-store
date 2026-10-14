# HANDOFF — teaming-mcp

> 交接文档。**新会话请先完整读完本文件，再动手。**
> 最后更新：2026-10-04

---

## 0. 一句话

一个**本地 stdio MCP 服务 + CLI**：读取飞书会议的逐字稿，按 Teaming 框架做团队动力分析，
产出四部分报告，并可把报告推送到飞书私信。供豆包工作 / WorkBuddy 等 AI 宿主调用。

**边界：只做分析和推送。不改飞书上的任何东西。只观察会议过程，不评价个人。**

---

## 1. 现在到哪一步了

| 阶段 | 内容 | 状态 |
|---|---|---|
| **1** | 核心链路：取逐字稿 → 分析 → 推送 | 🟢 **已用真实会议端到端跑通** |
| **2** | 装进宿主（MCP + Skill） | 🟢 **已装入 WorkBuddy**（配置 + 技能），并在**模拟 GUI 宿主环境**下验证三个工具可调；待 App 重载后人工确认 |
| **3** | 事件驱动自动触发（`watch`） | 🟡 逻辑已实现并用模拟事件验证；**未用真实事件验证**；尚无开机自启 |
| **4** | 多用户产品化 | ⬜ 未开始（见 §8） |

**已经真实发生过的事**（不是设想）：

- 用真实飞书会议「ABC周二测试」跑通全链路：搜索 → 详情 → 逐字稿（101 条发言）→ 分析（61~89 秒）→ **推送飞书私信成功**
- 推送后**独立复核**过：反查会话消息列表确认消息已到达（不只信 CLI 自己的返回）
- 模拟妙记生成事件驱动 `handleMinuteEvent`：首次完整走完、重复事件按 `event_id` 跳过、同 `minute_token` 不同 `event_id` 也跳过
- `npm test` 6 项全绿（含 stdout 纯净性、逐字稿转换）

---

## 2. 文件地图

| 文件 | 职责 |
|---|---|
| `src/mcpServer.mjs` | stdio MCP 入口。**第一行就把 `console.log` 重定向到 stderr**，保护 JSON-RPC 通道 |
| `src/cli.mjs` | 命令行：doctor / meetings / transcript / analyze / push / self-chat / watch |
| `src/lark.mjs` | 飞书能力封装（全部经 lark-cli），含逐字稿 HTML→文本转换、错误人话翻译 |
| `src/analysis.mjs` | 分析引擎加载、前置条件检查 |
| `src/pipeline.mjs` | 编排层：取数→分析→落盘→推送；幂等账本；事件处理 `handleMinuteEvent` |
| `src/render.mjs` | 报告 JSON → 飞书 markdown；`reportDigest` 紧凑摘要 |
| `src/engine-src/**` | **vendored** 的分析引擎源码（从 teaming-bot 同步，10 个文件） |
| `scripts/sync-engine.mjs` | 编译引擎到 `dist/engine/`，并写入 CJS 作用域声明 |
| `skills/teaming-meeting-analysis/SKILL.md` | 给宿主的技能说明书 |
| `tests/*.test.mjs` | 协议层与逐字稿转换测试，不联网 |

---

## 3. 已验证的硬事实（**别再重新验证一遍**）

| 事实 | 怎么验证的 |
|---|---|
| 飞书逐字稿有**两条可取路径** | ① 妙记：`minutes +detail --minute-tokens <t> --transcript --output-dir /tmp/...` → 从返回的 `artifacts.transcript_file` 读文件；② 智能纪要：`note +detail` 拿 `verbatim_doc_token` → `docs +fetch` 取 HTML 再转换。**两条都要保留**：实测 15 场会里 8 场只有妙记、2 场只有智能纪要 |
| **妙记路径的三个必要条件**（少一个就整个走不通） | ① flag 是 `--minute-tokens`（**复数**，单数会报 unknown flag）；② 必须显式传 `--transcript`，否则只返回基本信息；③ `--output-dir` 只允许 **cwd / `/tmp` / `~/files`**——macOS 的 `os.tmpdir()` 返回 `/var/folders/...`，**会被拒绝** |
| 真实会议可分析率 | **只认妙记后，实测 15 场里 8 场可分析**。不可分析的 7 场全是 `no_minute`（没录制）。<br>⚠️ 更早一次统计出"10 场成功"是**被智能纪要 fallback 撑高的**——那 2 场实际不可分析，按产品规则应当拒绝 |
| 有会议**逐字稿很短** | 实测最短 3 行。`src/analysis.mjs` 有 `transcript_too_short`（<50 字）拦截，但 10 余行的会仍会跑，产出会很薄——产品上要考虑是否加更严的门槛 |
| 逐字稿格式是 HTML，且 `<title>` 必须剥掉 | 不剥会粘到第一条发言上污染发言人姓名。**这是测试抓出来的真 bug** |
| 引擎认 `姓名 MM:SS 发言` 这个形状 | 见 `src/engine-src/lib/analysis/transcript.ts` 的 `matchSpeakerLine` |
| 引擎可脱离 Next.js 独立编译运行 | 10 个文件、零 Next.js 依赖，外部只用 `node:crypto` |
| 项目 `"type": "module"` 会让 CJS 引擎加载失败 | 报 `exports is not defined in ES module scope`。修法：构建时写 `dist/engine/package.json` 声明 commonjs |
| 用 `--user-id <自己的open_id>` 发消息会被拒 | 报 `99992351`。**必须用 `--chat-id`**（和自己单聊的 `oc_...`），`self-chat` 命令就是查这个 |
| `lark-cli` 的妙记事件订阅**绑在 consume 进程生命周期上** | 官方文档明示：minutes/vc/board 类的 PreConsume 会注册服务端订阅，**退出时注销**，`kill -9` 会泄漏订阅 |
| 分析结果有跑次差异 | 同一份逐字稿两次分析，一次判「可能是冷漠区或舒适区」，一次判「证据不足，暂不定位」。方向一致（都谨慎），但边界不稳定 |
| **GUI 宿主 PATH 不含 `/usr/local/bin`，光给 lark-cli 绝对路径也没用** | `lark-cli` 的 shebang 是 `#!/usr/bin/env node`，宿主 PATH 里找不到 node → ENOENT，极易被误判成"没装 lark-cli"。修法：由我们的 spawn 自己前置 PATH（`src/lark.mjs` 的 `SPAWN_ENV`） |
| AI 摘要**不能**替代逐字稿 | 团队动力分析需要成员原始发言；只有 AI 纪要时应当直接告诉用户无法分析 |
| **宿主有 `tools/call` 总超时** | 豆包工作 `libmcp_helper.dylib` 里有 `TOOL_CALL_TIMEOUT` / `tools/call total timeout` / `timeoutMs must be between 1 and ...`，但**默认值读不出来**。分析要 60~120 秒，因此必须走后台任务模式 |
| 后台任务模式已验证 | `wait_seconds=0` 立即返回 job_id；实测 40s/60s 时仍是 running，70s 变 done。**等待超时不会丢工作** |
| 分析引擎与 teaming-bot **逐字节一致** | 10 个文件全部 `diff` 为空、sha256 相同。**报告内容是团队 bot 的代码算的，不是重写的** |
| 推送必须是**交互卡片**，不能是纯文本 | 产品明确要求。`msg_type` 必须是 `interactive`；发 markdown 会变成 `post`，形态不对。实测已确认消息列表里显示为 `interactive` |
| lark-cli 发卡片的方式 | `im +messages-send --msg-type interactive --content '<卡片JSON>'`。`--content` 传的是卡片的 JSON 字符串 |

---

## 4. 安全不变量（改动时必须保持）

1. **stdout 只走 JSON-RPC**。任何一行日志写进 stdout 都会破坏握手，表现为"连接器显示已连接但没有工具"。
2. **凭证只从环境变量读**，不落盘、不返回、不打日志。
3. **`.out/` 与 `.state/` 含会议原文**，已在 `.gitignore` 排除，绝不入库。
4. **推送幂等**：`idempotency-key` 由 `meetingId + zone` 派生，重复执行不产生重复消息。
5. **账本先于推送落盘**：崩溃重放不会重复分析、不会重复推送。
6. **不给不出结论**：证据不足时如实说，不编造。
7. **不评价个人**：只观察会议过程。

---

## 5. 引擎同步约定（**重要**）

`src/engine-src/` 是从 [`../teaming-bot`](../teaming-bot) **vendored** 过来的：

```text
teaming-bot/src/lib/analysis/{engine,decision,evidence,evidenceBudget,prompts,provider,transcript}.ts
teaming-bot/src/types/{index,v1,v2}.ts
```

**同步时机**：teaming-bot 改了分析提示词、Zone 判定规则或报告结构时。

**同步方法**：把上述文件覆盖到 `src/engine-src/` 对应位置，再 `npm run build`。

**为什么不用依赖而是 vendored**：本包要能独立 npm 发布，不能依赖 teaming-bot 的源码树。
**代价**：会漂移。这是已知取舍，靠本节约定管理。

---

## 6. 踩过的坑（别再踩）

| 坑 | 教训 |
|---|---|
| `<title>` 没剥 | 会粘到第一条发言上，污染发言人姓名。**测试抓到的** |
| `"type": "module"` + CJS 引擎 | 报 `exports is not defined`。构建时补 `dist/engine/package.json` |
| 用 `--user-id` 发给自己 | 飞书拒（99992351）。**用 `--chat-id`** |
| 正则 `/^[uo]_/` 匹配 `ou_xxx` | 匹配不到（`ou` 后是 `u` 不是 `_`）。写 `/^ou_/` 或 `startsWith` |
| `node --test <目录>` 在本机报错 | 改成 `node --test tests/*.test.mjs` |
| GUI 进程不继承 shell PATH | MCP 配置里 `command` 必须写 `/usr/local/bin/node` 绝对路径 |
| **只解决"我们的 command"不够** | 我们 spawn 出去的 lark-cli 同样受宿主 PATH 影响。它的 shebang `#!/usr/bin/env node` 会失败。**必须由代码自己补 PATH**，不能只靠配置文件 |
| 体检漏检查 lark-cli | 早期 `teaming_doctor` 只查引擎，导致"体检通过但飞书工具全挂"。现在 `larkReadiness()` 覆盖 lark-cli 存在性、授权与 scope |
| **`teaming_analyze_meeting` 默认内联等待会撞上宿主超时** | 前置检查（lark-cli 取数）约 17 秒 + 内联等待 45 秒 = 62 秒，超过豆包工作的 `tools/call` 超时（约 60 秒），宿主在第 60 秒取消调用 → 用户看到"失败"，**但分析其实已经跑完并落了报告**。默认等待已降到 10 秒；SKILL 补了"被取消不等于失败，先查 job_status" |
| **引擎的 `getBaseUrl()` 没有默认值** | 不配 `DOUBAO_BASE_URL` 就会抛「未配置…」→ 被 catch → `analysisMode=basic_fallback`，而提示写的是「模型服务未完成核心分析，请稍后重试」——**把配置问题说成了服务问题**。2026-10-14 在豆包工作里连试两次都中招。现已内置方舟默认端点，并在 doctor 里展示生效端点 |
| **只认 `status === 'ready'` 判授权** | lark-cli 对"访问令牌过期、refresh token 有效"报 `needs_refresh`，含义是**下次调用自动刷新**，属正常状态。曾经**两份代码副本**都只认 `ready`，于是在豆包工作里实测时，用户授权明明正常、体检却让去重新登录。现已抽成 `src/readiness.mjs` 的纯函数 `isLarkUserUsable`，规则只有一份且可测 |
| **WorkBuddy 里自定义 MCP 必须手动信任一次** | 仅把条目写进 `~/.workbuddy/mcp.json` 不生效：必须在该 App 的「自定义连接器」入口点一次「信任」，否则工具检索里完全看不到 `teaming_*`，表现与"没配"一模一样。信任记录在 `~/.workbuddy/mcp-approvals.json`（键为 `<sha256>::<服务器名>`，哈希含盐、无法手工构造，只能走 UI）。**这是"改了 src 要重载宿主"的同类问题：配置对 ≠ 生效。** |
| 改了 `src/` 忘了重载宿主 | 宿主不会自动重载连接器，要关闭再打开开关或重启 App |

---

## 7. 测试怎么做

```bash
npm test                     # 6 项：MCP 协议 + stdout 纯净性 + 逐字稿转换（不联网）
node src/cli.mjs doctor      # 环境体检（需要 lark-cli 已授权）
```

端到端（会真的调模型、真的发消息，注意副作用）：

```bash
node --env-file=<含DOUBAO_API_KEY的文件> src/cli.mjs analyze <meetingId> --json
node src/cli.mjs push <报告.json> --chat <你的chat_id> --dry-run   # 先预览
```

---

## 8. 下一步（按优先级）

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~在豆包工作 / WorkBuddy 里实测连接器~~ | 🟢 **2026-10-14 已在豆包工作里跑通**：宿主成功拉起 MCP 并调到 `teaming_doctor`（之前报的"未授权"是 doctor 自己的误判，已修）。下一步在宿主里试 `teaming_list_meetings` 与真实分析 |
| 2 | 用**真实事件**验证 `watch` | 需要一个真实的妙记生成事件触发 |
| **报告链接只能落到飞书文档兜底** | `src/publish.mjs` 会先 `POST {TEAMING_SERVER_URL}/api/host/reports` 换真正的报告页（含图表），失败才退到飞书文档。**但两端都没对齐**：MCP 用的是 `/api/host/reports`，而 teaming-bot 的 ADR（`docs/AI宿主接入设计.md`）规定的是 `/api/host/v1/*`；且服务端该路由**尚未实现**。所以卡片按钮现在指向文档兜底页，图表出不来。要做成完整体验，需先实现服务端 `/api/host/v1/reports` 并把 MCP 的路径对齐。 |
| **报告链接只能落到飞书文档兜底** | `src/publish.mjs` 会先 `POST {TEAMING_SERVER_URL}/api/host/reports` 换真正的报告页（含图表），失败才退飞书文档。**但两端没对齐**：MCP 用 `/api/host/reports`，teaming-bot 的 ADR（`docs/AI宿主接入设计.md`）规定 `/api/host/v1/*`；且服务端该路由**尚未实现**。所以卡片按钮指向文档兜底页、图表出不来。要完整体验，需实现服务端 `/api/host/v1/reports` 并把 MCP 路径对齐。 |
| 3 | 处理**跑次差异** | 同一会议两次分析边界不一致，产品上需要定策略（固定输出"证据不足/靠近边界"？） |
| 4 | 多用户产品化 | 现在是**单用户本机工具**（用本机 lark-cli 授权）。给真实用户用需要：平台应用 + 用户授权 + 服务端常驻订阅。**注意：不要试图用本项目的 `watch` 承担多用户可靠性** |

---

## 9. 与 teaming-bot 的关系

| | teaming-bot | 本项目 |
|---|---|---|
| 定位 | 服务端产品（多用户、常驻、数据库） | **本机工具 / MCP 连接器** |
| 事件接收 | 服务端 WSClient + 持久订阅 | 本机 `lark-cli event consume`（进程级） |
| 分析 | 同一套引擎 | 同步过来的同一套引擎 |
| 存储 | Postgres / Supabase | 本地文件 |
| 多用户 | ✅ 已支持 | ❌ 单用户 |

**两者共用分析引擎，但运行形态完全不同。** 不要在两者之间互相 import。
