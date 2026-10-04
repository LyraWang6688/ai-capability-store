# teaming-mcp

把一场**已结束的飞书会议**变成一份**团队动力分析报告**，并把报告推送到你的飞书。

可装进 **豆包工作**、**WorkBuddy** 等支持 MCP 的 AI 宿主；也可以直接当命令行工具用。

```text
飞书妙记/智能纪要逐字稿
        ↓
  团队动力分析（Teaming 框架 + Kantor 互动功能模型）
        ↓
  四部分报告：团队状态定位 / 互动概览 / 未完成的对话与非共识 / 给领导者的建议
        ↓
  推送到飞书私信
```

---

## 一、它解决什么问题

开完会，团队到底处在什么状态？心理安全够不够？要求清不清晰？

这份报告**只观察会议过程，不评价个人**。它是给组长或助教用来改进协作的，不是考核工具。

**它不会为了给出结论而编造。** 证据不足时会明确说"证据不足，暂不定位"。

---

## 二、前置条件

| 依赖 | 说明 |
|---|---|
| **Node.js ≥ 20** | 运行环境 |
| **lark-cli ≥ 1.0.97** | 飞书官方 CLI，本项目用它取数、推送。`npm install -g @larksuite/cli` |
| **飞书授权** | `lark-cli auth login --recommend` |
| **分析凭证** | 环境变量 `DOUBAO_API_KEY`（豆包方舟） |

第一次用先跑体检：

```bash
node src/cli.mjs doctor
```

六项全绿才能开始。哪项红，它会告诉你下一步做什么。

---

## 三、装进 AI 宿主

### 豆包工作

`技能 · 连接器 · 伙伴` → 添加 → **新建自定义连接器**：

| 字段 | 值 |
|---|---|
| 传输类型 | STDIO |
| 命令 | `/usr/local/bin/node`（**必须绝对路径**，GUI 不继承 PATH） |
| 参数 | 本目录下 `src/mcpServer.mjs` 的绝对路径 |
| 环境变量 | `DOUBAO_API_KEY` = 你的豆包方舟 Key |

再把 `skills/teaming-meeting-analysis/` 里的 `SKILL.md` 作为技能导入（若界面支持技能包导入）。

### WorkBuddy

编辑 `~/.workbuddy/mcp.json`：

```json
{
  "mcpServers": {
    "teaming": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/绝对路径/teaming-mcp/src/mcpServer.mjs"],
      "env": { "DOUBAO_API_KEY": "..." },
      "disabled": false
    }
  }
}
```

技能放到 `~/.workbuddy/skills/teaming-meeting-analysis/SKILL.md`。

> 改完配置要在 App 里**重新加载连接器**（关闭再打开开关，或重启 App）。
> 改完源码不需要重启——本项目直接运行 `.mjs` 源码，没有构建步骤（引擎除外）。

---

## 四、MCP 工具

| 工具 | 副作用 | 用途 |
|---|---|---|
| `teaming_doctor` | 无 | 体检：飞书授权、分析凭证、引擎是否就绪 |
| `teaming_list_meetings` | 无 | 列出近期会议，标注哪场有逐字稿 |
| `teaming_read_report` | 无 | 读已生成报告的摘要 |
| `teaming_analyze_meeting` | 有 | 分析一场会（60~120 秒） |

**关于超时**：单次分析要一两分钟，可能超过宿主的工具调用超时。超时时工具会返回 `fallback_command`，在终端执行即可（终端没有工具超时限制）。

---

## 五、命令行用法

```bash
node src/cli.mjs doctor                       # 自检
node src/cli.mjs meetings --days 30           # 列出近期会议
node src/cli.mjs transcript <meetingId>       # 取逐字稿
node src/cli.mjs analyze <meetingId> --json   # 取数 + 分析
node src/cli.mjs self-chat                    # 查出推送用的 chat_id
node src/cli.mjs push <报告.json> --chat <id> # 推送（幂等）
node src/cli.mjs watch --chat <id>            # 监听妙记生成事件，自动分析 + 自动推送
```

`watch` 是**事件驱动**的：飞书妙记生成 → 自动分析 → 自动推送。

> ⚠️ `watch` 依赖 `lark-cli event consume`，而它的订阅是**进程启动时注册、退出时注销**。
> 也就是说：**进程不在跑，就完全收不到事件**（不是漏几条，是没订阅）。
> 需要 7×24 可靠的话，应该改成"订阅一次 + 服务端常驻消费者"，而不是依赖这个前台进程。

---

## 六、开发

```bash
npm run build     # 编译分析引擎到 dist/engine/
npm test          # 协议层 + 逐字稿转换测试（不联网）
```

> 引擎源码在 `src/engine-src/`，是从 [teaming-bot](../teaming-bot) 同步过来的。
> 上游改了分析逻辑，要重新同步——见 [HANDOFF.md](./HANDOFF.md) 的同步约定。

---

## 七、隐私

- 分析输出（`.out/`）和事件账本（`.state/`）**含会议原文**，已在 `.gitignore` 中排除。**不要提交，不要外发。**
- 凭证只从环境变量读取，不落盘、不返回、不打日志。
- 报告只观察会议过程，不评价个人。
