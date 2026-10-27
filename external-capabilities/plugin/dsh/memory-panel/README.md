# @lyra_wang/dsh-memory-panel

在 DSH 里浏览 ai-memory 的记忆，**并且第一眼就能看出当前落在哪个桶**。

## 为什么需要它

ai-memory 按 `workspace/project` 分桶，而三处入口的推导口径不同：

| 入口 | 推导方式 |
|---|---|
| hooks 自动采集 | `cwd` → `git remote` → `<owner>-<repo>` |
| MCP（`--no-session-id`） | 拿不到 cwd → 落到 `default/memories` 兜底槽 |
| 别的 harness（如 Codex） | 从哪个目录启动就用哪个目录名 |

结果就是**同一个仓库的数据被写进不同桶，彼此查不到**。这个面板把「当前桶」放在最顶上，并列出所有桶的页数，**错桶一眼可见**。

## 界面

```
输入框左侧:  🧠 记忆          ← 一个按钮

点击后右侧浮出面板:
┌─────────────────────────────────┐
│ 🧠 记忆                      ✕  │
│ 当前桶：default / lyrawang…     │  ← 核心：桶坐标
│ [搜索框……………………] [搜索]     │
│ [桶下拉：xxx · 3 页        ▾]  │
├─────────────────────────────────┤
│ 页  sessions/01a1797a…          │
│ 原始 tool non-file              │
└─────────────────────────────────┘
```

## 接口

**Host 半（`index.js`）** — 用 `ctx.webServer.register` 注册三条路由：

| 路由 | 作用 |
|---|---|
| `GET /plugins/memory/projects` | 代理 ai-memory `GET /api/v1/projects` |
| `GET /plugins/memory/resolve?cwd=` | 从 `<cwd>/.git/config` 推导 `{workspace, project}`，不 spawn git |
| `POST /plugins/memory/rpc` | 代理 `POST /mcp` 的 `tools/call` |

**浏览器端永不接触 bearer token** —— Host 从 ai-memory 数据目录的 `auth-header` 读取后转发。

**Client 半（`client.js`）**：

| 槽位 | 用途 |
|---|---|
| `conversation.input.left` | 「🧠 记忆」按钮 |
| `shell.overlay` | 右侧浮层面板（`position:fixed`） |

> ⚠️ **不用 `ctx.sidebarRight`** —— 第三方插件拿不到它（4 种方式全失败，`dsh.client.inject` 会让 App 启动失败）。见 `../README.md` 4.1。

## 坐标推导规则

与 hooks 口径一致：

```
workspace = "default"
project   = <git remote 的 owner>-<repo>，全小写
            无 git remote → 目录名小写
```

已验证（4 种 remote 写法 + 4 个真实目录）。

## 配置

`cordis.patch.yml` 里可改：

```yaml
config:
  serverUrl: "http://127.0.0.1:49374"
  dataDir: "/Users/wangying/Library/Application Support/ai-memory"
```

## 状态

- [x] Host 三路由实测通过（projects / resolve / rpc）
- [x] 坐标推导与 hooks 一致
- [ ] Client 半装入 profile 实测（需隔离测试环境）
