# dsh-feishu-remote

在飞书里私聊一个机器人，让**你自己的电脑**执行任务，结果回传飞书。

```
手机/飞书 ──私聊机器人──▶ 飞书开放平台（长连接）
                              │
                              ▼
                       本机常驻进程（launchd / 你自己的进程管理器）
                              │ 白名单校验 → 高风险确认 → 队列
                              ▼
                       dsh headless "<任务>"（可换成任何命令）
                              │
                              ▼
                       结果发回飞书
```

- **不依赖公网端口**：走 lark-cli 的 WebSocket 长连接；
- **执行后端可替换**：默认 `dsh headless`，也可以指向你自己的 agent / 脚本；
- **凭据零入库**：复用 lark-cli 的凭据库与系统钥匙串，本项目不存任何 token；
- **高风险动作先确认**：含「删除/转账/清空」等词的指令，先回确认卡片文案，回复「确认」才执行；
- **审计留痕**：每个任务一行 JSONL（谁、何时、指令、耗时、结果长度）。

## 前置条件

1. **Node.js ≥ 20**
2. **lark-cli** 已安装并授权：

   ```sh
   npm i -g @larksuite/cli
   lark-cli profile add --name my-bot --app-id cli_xxx --app-secret-stdin
   lark-cli auth login --domain im
   ```

3. **一个飞书自建应用**（在 [开放平台](https://open.feishu.cn/app) 里）：
   - 开启**机器人**能力；
   - 事件订阅添加 `im.message.receive_v1`（**长连接**模式）；
   - 权限：`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message`；
   - 发布一个可用版本，并把机器人加进你的私聊。
4. **执行后端**：默认用 DSH（`dsh headless`）；也可以换成你自己的命令（见配置 `dshCli` / `agentArgs`）。
5. **模型 API Key**（用 DSH 时）：放在环境变量或系统钥匙串，例如：

   ```sh
   security add-generic-password -a "$USER" -s DEEPSEEK_API_KEY -w "<key>"
   ```

## 快速开始

```sh
npx @lyra_wang/dsh-feishu-remote init
```

`init` 会：读取你当前 lark-cli 账号的 open_id 作为白名单 → 询问工作目录 → 写配置（`~/.dsh-feishu-remote/config.json`，600）→ 安装 launchd 开机自启（macOS）。

然后 **在飞书私聊机器人**发一句「帮助」即可。

## 命令

| 命令 | 作用 |
|---|---|
| `init` | 交互式初始化（`--yes` 非交互，`--no-service` 不装服务） |
| `doctor` | 环境体检：lark-cli / 授权 / 事件订阅 / 执行后端 / Key / 服务 |
| `status` | 配置摘要 + 服务状态 + 最近任务 |
| `logs [--lines N]` | 看审计日志 |
| `run` | 前台运行（调试用） |
| `install-service` / `uninstall-service` | launchd 安装 / 卸载（macOS） |
| `config` | 打印配置路径与当前值 |

## 配置（`~/.dsh-feishu-remote/config.json`）

| 字段 | 说明 |
|---|---|
| `allowedOpenIds` | 允许发送指令的飞书 open_id 列表（**必填**） |
| `workdir` | 任务执行目录 |
| `larkCli` / `larkProfile` | lark-cli 可执行文件与 profile |
| `dshCli` / `agentArgs` | 执行后端命令（默认 `dsh` + `headless`） |
| `timeoutSeconds` | 单任务超时（默认 300） |
| `maxReplyChars` | 回传消息截断长度（默认 3500） |
| `highRiskPatterns` | 触发确认的高风险词 |
| `apiKeyEnv` / `keychainService` | 模型 Key 的环境变量名 / 钥匙串条目名 |
| `allowedChatTypes` | 允许的会话类型（默认仅 `p2p`） |

## 安全模型

- 只响应**白名单 open_id** + 仅私聊（可配）；
- 高风险词先确认，回复「确认」才执行，「取消」直接丢弃；
- 凭据在 lark-cli 凭据库 / 系统钥匙串，配置与审计文件权限 600，仓库内零 token；
- 服务进程以当前用户身份运行，能读写 `workdir`（按你的需要设置）。

## 常见问题

**发消息没反应？**

```sh
dsh-feishu-remote doctor
```

重点看「飞书事件订阅」和「白名单」两项。

**电脑睡眠后不响应？** 安装服务时会用 `caffeinate` 包裹进程；把 macOS 的睡眠时间设为"永不"或接电源。

**想换执行后端？** 改 `dshCli` 与 `agentArgs`，例如 `{"dshCli": "claude", "agentArgs": ["-p"]}`。

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
