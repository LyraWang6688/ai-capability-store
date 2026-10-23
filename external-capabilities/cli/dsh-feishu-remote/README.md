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
- **审计留痕**：每个任务一行 JSONL（谁、何时、指令、耗时、结果长度）；
- **回复都是卡片**：任务结果 / 失败 / 高风险确认 / 帮助 / 状态统一用飞书 **Card 2.0** 呈现（客户端需 ≥ 7.20），卡片发送失败时自动降级为文本。

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

`init` 会：读取你当前 lark-cli 账号的 open_id 作为白名单 → 询问工作目录 → 写配置（`~/.dsh-feishu-remote/config.json`，600）→ 安装开机自启：
- **macOS**：launchd（`com.lyrawang.dsh-feishu-remote`）
- **Linux**：systemd user unit（`~/.config/systemd/user/com.lyrawang.dsh-feishu-remote.service`）

> Linux 上 `init` 安装完会尝试 `loginctl enable-linger`；普通用户通常没有这个权限，
> 需要 root 先替该用户执行一次 `sudo loginctl enable-linger <user>`，否则用户级 systemd
> 在用户未登录时不会拉起服务。没有开启 linger 时 `init` 会在输出里提示，不会中断安装。

> 只有 bot 身份、走不了用户登录的设备（典型是 Linux 服务器）：`init` 要加
> `--open-id ou_xxx`，否则它读不到你的 open_id 当白名单。收发消息本来就只用 bot，
> 所以 `doctor` 只要求 bot 身份就绪；读不到用户身份时白名单改为提示核对。

然后 **在飞书私聊机器人**发一句「帮助」即可。

## 命令

| 命令 | 作用 |
|---|---|
| `init` | 交互式初始化（`--yes` 非交互，`--no-service` 不装服务，`--open-id` 用于只有 bot 身份的机器） |
| `doctor` | 环境体检：lark-cli / 授权 / 事件订阅 / 执行后端 / Key / 服务 |
| `status` | 配置摘要 + 服务状态 + 最近任务 |
| `logs [--lines N]` | 看审计日志 |
| `run` | 前台运行（调试用） |
| `install-service` / `uninstall-service` | 开机自启安装 / 卸载（macOS launchd / Linux systemd） |
| `config` | 打印配置路径与当前值 |

## 配置（`~/.dsh-feishu-remote/config.json`）

| 字段 | 说明 |
|---|---|
| `allowedOpenIds` | 允许发送指令的飞书 open_id 列表（**必填**） |
| `workdir` | 任务执行目录 |
| `larkCli` / `larkProfile` | lark-cli 可执行文件与 profile |
| `dshCli` / `agentArgs` | 执行后端命令（默认 `dsh` + `headless`） |
| `timeoutSeconds` | 单任务超时（默认 300） |
| `maxReplyChars` | 回传卡片正文的截断长度（默认 3500） |
| `highRiskPatterns` | 触发确认的高风险词 |
| `apiKeyEnv` / `keychainService` | 模型 Key 的环境变量名 / 钥匙串条目名（Linux 没有钥匙串，配 `keychainService: ""`） |
| `allowedChatTypes` | 允许的会话类型（默认仅 `p2p`） |
| `extraEnv` | 追加给执行后端的环境变量。**Linux 上通常要把 `PATH` 指到 DSH 用的 node 目录**（见下节） |

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

**电脑睡眠后不响应？** macOS 安装服务时会用 `caffeinate` 包裹进程；把睡眠时间设为"永不"或接电源。

**飞书授权到期了怎么办？** 正常情况下 token 每 6 小时自动滚动续期，不需要手动处理。真失效时，在飞书里回复「重新授权」，会收到一张带按钮的卡片，点按钮即可续期。

## 在 Linux 服务器上常驻

```bash
# 1. 装 CLI（只依赖 node 20+ 跑 CLI 自身，DSH 用哪个 node 见下面「部署前必须对齐的三件事」）
npm install -g --prefix ~/.local @lyra_wang/dsh-feishu-remote
# 2. 先授权飞书机器人
lark-cli auth login --as bot
# 3. 让用户级 systemd 在用户未登录时也能常驻（需要 root 执行一次）
sudo loginctl enable-linger "$USER"
# 4. 初始化：写配置 + 安装并启动 systemd user unit（只有 bot 身份时加 --open-id ou_xxx）
~/.local/bin/dsh-feishu-remote init --workdir ~/work --open-id ou_xxx
# 5. 把模型 key 写进环境文件（服务启动时读取，替代 macOS 钥匙串）
echo 'DEEPSEEK_API_KEY=sk-...' > ~/.dsh-feishu-remote/env && chmod 600 ~/.dsh-feishu-remote/env
# 6. 重启并查看状态
systemctl --user restart com.lyrawang.dsh-feishu-remote
systemctl --user status com.lyrawang.dsh-feishu-remote
```

### 部署前必须对齐的三件事

**1. DSH 必须跑在它要求的 Node 版本上。** `dsh` 的入口是
`if (import.meta.main) await runCli()`，而 `import.meta.main` 在 Node 24 之前是
`undefined`。用更老的 node 调 `dsh`（包括它自己的 shebang `#!/usr/bin/env node`
解析到老版本）会**退出码 0、零输出、零报错**——看起来一切正常，实际什么也没做。

所以 Linux 上要把 DSH 用的 node 目录放进配置的 `extraEnv.PATH`，服务脚本会以它
作为启动 PATH（不配则沿用一套不含该目录的默认 PATH）：

```json
{
  "extraEnv": { "PATH": "/opt/dsh-runtime/node/bin:/usr/local/bin:/usr/bin:/bin" }
}
```

先验证后端可用：`dsh headless "只回复两个字：在线"` 应输出「在线」，而不是空。

**2. `keychainService` 置空。** Linux 没有 `security` 命令，模型 Key 走
`~/.dsh-feishu-remote/env`（600）里的环境变量；配了 `keychainService` 只会多一条
无效的 keychain 读取。

**3. 同一个飞书应用的长连接只能有一处在消费。** 如果本机一直在跑，
把服务迁到服务器前先执行 `dsh-feishu-remote uninstall-service` 停掉本机那份，
否则两边会分走消息。

**想换执行后端？** 改 `dshCli` 与 `agentArgs`，例如 `{"dshCli": "claude", "agentArgs": ["-p"]}`。

## 会话复用（0.2.0）

飞书私聊里的连续对话会**复用同一个 DSH 会话**，不再每条消息新建一个会话：

- 每个飞书 `chat_id` 记住最近一次的 `sessionId`（存于 `~/.dsh-feishu-remote/state.json` 的 `sessions` 字段）；
- 再次发消息时用 `dsh --profile headless --session-id <id> --json` 继续同一会话；
- 如果该会话已被删除，自动改用新会话并更新记录；
- 配置项 `reuseSession`（默认 `true`）可关闭。

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

