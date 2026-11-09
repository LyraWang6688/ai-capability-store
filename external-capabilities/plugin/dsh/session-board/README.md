# @lyra_wang/dsh-session-board

会话需求看板：**按「需求」而不是按消息**，列出这个会话里你提过哪些目标、智能体为每条需求拆出了哪些子任务、各自跑到哪一步。

## 为什么需要它

一个会话里会有多轮对话、多个子智能体、几块任务板。你真正想知道的是三件事：

1. 这个会话我**一共提了几件事**；
2. 每件事现在**到哪一步了**；
3. 哪件事**卡住了**。

而会话界面是按时间线排的，消息一多就看不出「哪几条消息其实是同一件事」。这个面板把时间线折叠成需求列表。

## 界面

点输入框左侧的「📋 需求」按钮，打开的是**官方右侧栏里的「📋 需求」tab**——与终端、浏览器、文件那些 tab 并列。没有自绘浮层，也没有兜底路径：右侧栏拿不到就不显示，不做第二套皮。

面板：

```
┌────────────────────────────────┐
│ 📋 需求看板        [刷新][重判] ✕│
│ 3 条需求 · 42 条消息 · 7 个任务  │
├────────────────────────────────┤
│ 1  会话需求看板          进行中  │
│   跑着  设计需求聚合            │
│   · 我想在右侧边栏做个看板…      │
│   · 其实不是，多条消息可能…      │  ← 判定为同一条需求的更正
│ 2  发布公众号插件         已完成  │
└────────────────────────────────┘
```

点一条需求展开：下面挂着它派出的子任务（`subagent` / `spawn_teammate` / `workflow` / `team_task_*` …）及状态，再下面是这条需求里你说过的话。

## 需求是怎么判定的

**一条需求 = 一个目标 + 围绕它的全部对话**，包括中途的更正、补充、返工。判据不是它说了几次，而是**目标有没有换**。

消息归属按四个信号判：

| 信号 | 处理 |
|---|---|
| 纠正/延续措辞（「其实不是」「不对」「改成」「补充」「另外」…） | 并入上一条需求 |
| 与上一条需求近几条消息的字面重合（字符二元组重合度 ≥ 0.12） | 并入 |
| 距上一条消息不到 30 分钟 | 并入 |
| 都不命中 | 新开一条需求 |

最后一条是兜底：**拿不准就并入**。误判有两种方向——多切（一条需求裂成几条，状态互相矛盾，看板开始说谎）和少切（两条需求挤一条，边界看不清）。少切只是粗，多切是错。

**切分结果会落盘**（`~/.dsh/session-board/<session>.json`），不是每次刷新现算。现算会让条目数在两次刷新之间漂移，那比不准更糟——你会以为自己记错了。新消息只做增量判断：并入最后一条，或者新开一条。

判错了可以修：

- 展开某条需求 →「**并入上一条**」：两条被错误切开的需求合并回去；
- 「**最后一条另起**」：把这一条需求里的最后一条消息拆出去独立成条；
- 顶部「**重判**」：清掉本机保存的切分，从头再判一次。

## 状态是怎么算的

| 状态 | 含义 |
|---|---|
| 进行中 | 有任务还在跑，或这条需求的最后一轮还没结束 |
| 已完成 | 任务都结束了，且没有失败的 |
| 受阻 | 有任务返回了错误 |

子任务状态来自它对应的 `tool/result`：有结果 = 完成，有 `error` = 失败，只有调用没有结果 = 还在跑。

## 接口

**Host 半（`index.js`）** 用 `ctx.webServer.register` 注册一条路由：

| 路由 | 作用 |
|---|---|
| `GET /plugins/session-board/board?session=<id>` | 读该会话事件日志，投影成需求/任务/子会话 |
| `POST /plugins/session-board/board` | `merge` / `split` / `reset` 修正切分 |

数据源是 DSH 自己的服务，不引入第二个数据库：

- `sessionQuery.readSession()` / `filterSessions()` — 会话事件与父子会话；
- 事件类型只用到 `user/message`、`tool/call`、`tool/result`、`turn/end`。

**Client 半（`client.js`）** 注册两个槽位：

- `conversation.input.left` — 输入框左侧的「📋 需求」按钮；
- `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title` — 右侧栏里那块 tab 的体与标题。

打开时每 4 秒拉一次。

## 进右侧栏要同时声明两处

第三方 Client 插件拿右侧栏，缺一处都拿不到：

| 位置 | 写什么 | 作用 |
|---|---|---|
| `package.json` → `dsh.client.inject` | `@deepseek-ai/dsh-client-ui-sidebar-right` | 让宿主把这个官方包编进本插件的 bundle |
| Client 模块的 Cordis `inject` | `['slots', 'sidebarRightTabs', 'sidebarRight']` | 宿主在 `apply` 之前把服务发下来 |

拿到之后按官方形状注册：

```js
ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide });
ctx.slots.inject('sidebar.right.pane.tab',       () => ctx.slots.register({ name, key: id, inject: (sessionId) => ({ sessionId }) }, TabBody));
ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name, key: id }, TabTitle));
ctx.sidebarRight.openTab(kind);
```

> 仓库 `plugin/dsh/README.md` §4.1 记的是 2026-10 的结论（第三方拿不到 `sidebarRight`，4 种取法全失败）。**这条已经过期**：2026-11-09 在本机 DSH 上用 client inspect 查 `sidebar.right.pane.tab` 的占位者，一个 `@dsh-local/*` 的本地第三方插件 `active: true` 地占着这个 slot。

## 已知限制

- 只走官方右侧栏，不做兜底。`sidebarRight` / `sidebarRightTabs` 是 Cordis `inject` 依赖，不是运行时探测：宿主不提供时本插件的 Client 半不激活（按钮和 tab 都不出现），而不是退化成浮层。
- **版本绑定较紧**。这份实现按 2026-11 的宿主形状写（`sidebarRightTabs.register` + `sidebar.right.pane.tab` + `openTab(kind)`）。`dsh.client.inject` 里那一条如果指不到官方包，后果是 Client 半整体激活失败（这正是 `plugin/dsh/README.md` §4.1 当初记的故障），所以升级/降级 DSH 后要复验。
- 只读。不改会话、不改任务板、不替智能体做决定；唯一的写是本机那份切分缓存。
- 需求判定是启发式的，**必然会在某些会话上判错**——这正是那三个修正按钮存在的原因。
- 需求来自**日志回放**，不依赖智能体主动上报；好处是不需要智能体配合，代价是它认不出「智能体心里怎么想的」，只认你说过的话。
- 子智能体的「进行中」按会话是否 live 判断，不读子会话自己的事件流。
