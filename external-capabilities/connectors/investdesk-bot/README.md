# investdesk-bot

飞书「投资助手」机器人：在飞书里对话查持仓、查行情、记录想法，并把每轮问答自动沉淀到多维表格。

## 它解决什么

灵感是随时随地的，PC 端满足不了。这个机器人让你在地铁上、手机上打开飞书就能：

- 问「我的组合今天怎么样」→ 读飞书持仓，报市值/盈亏/今日涨跌
- 问「510300 现在多少钱」→ 查最新价或净值
- 说「记一下，关注 AI 算力」→ 写入想法池
- 问「我之前提过什么」→ 翻历史记录

## 架构

```
飞书 App（手机/桌面）
    ↕ 长连接 WebSocket（无需公网 IP、无需备案域名）
investdesk-bot 容器（腾讯云 43.143.239.42）
    ├── DeepSeek API        对话 + function calling
    ├── investdesk-quotes   查行情、读持仓
    └── investdesk-ideas    读写想法池
    ↕
飞书多维表格
```

**不映射任何入站端口**：长连接和 API 调用都是出网。

## 工具

| 工具 | 来源 | 用途 |
|---|---|---|
| `lookup_quotes` | investdesk-quotes | 查价格/净值 |
| `portfolio_overview` | investdesk-quotes | 持仓汇总 |
| `save_idea` | investdesk-ideas | 写入想法池 |
| `list_ideas` | investdesk-ideas | 列历史记录 |
| `search_ideas` | investdesk-ideas | 关键词搜索 |

## 部署

代码在服务器上从 GitHub 克隆（仓库公开，无需凭据）：

```
/opt/ai-capability-store/                               ← git clone
└── external-capabilities/connectors/investdesk-bot/
    ├── .env        ← 600 权限，本地维护，不进 git
    └── docker compose up -d --build
```

**更新**（服务器上，一条命令）：

```bash
/opt/ai-capability-store/external-capabilities/connectors/investdesk-bot/deploy/update.sh
```

等价于：

```bash
cd /opt/ai-capability-store && git pull
cd external-capabilities/connectors/investdesk-bot && docker compose up -d --build
```

**首次部署**：

```bash
sudo mkdir -p /opt/ai-capability-store && sudo chown $USER:$USER /opt/ai-capability-store
git clone https://github.com/LyraWang6688/ai-capability-store.git /opt/ai-capability-store
cd /opt/ai-capability-store/external-capabilities/connectors/investdesk-bot
cp .env.example .env && vi .env      # 填 7 项配置
chmod 600 .env
docker compose up -d --build
```

## 配置

`.env`（600 权限，不进 git）：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
INVESTDESK_BASE_TOKEN=
INVESTDESK_HOLDINGS_TABLE=
INVESTDESK_PLATFORMS_TABLE=
INVESTDESK_IDEAS_TABLE=
DEEPSEEK_API_KEY=
```

飞书应用需要：**机器人能力** + 权限 `im:message`、`im:message.p2p_msg:readonly` + 事件 `im.message.receive_v1`（长连接方式）。

## 运行状态

```bash
ssh 43.143.239.42
cd /opt/ai-capability-store/external-capabilities/connectors/investdesk-bot
docker compose logs -f          # 看日志
docker compose restart          # 重启
docker compose down             # 停止（数据卷保留）
```

日志关键字：`[recv]` 收到消息、`[done]` 回复完成、`[idea]` 写入想法池。

## 数据

- **会话记忆**：命名卷 `investdesk-bot_bot-data` → `/app/data/sessions.json`，重建容器不丢
- **想法池**：飞书多维表格，字段见 `investdesk-ideas` 的 README

## 已知限制

- 只支持文字消息（图片/语音未处理）
- 群聊需 @ 机器人才响应（`im:message.group_at_msg:readonly` 权限未申请）
- 机器人回复依赖 DeepSeek，模型判断偶尔会把「累计盈亏」说成「当前涨跌」
- 会话历史按 chat_id 存，重启后仍在；但没有跨会话的长期记忆
