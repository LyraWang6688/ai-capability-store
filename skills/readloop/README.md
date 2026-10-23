# ReadLoop Skill

> 读的时候暴露短板，AI 助手按时帮你复习。

这个压缩包里是一份给 AI 助手用的技能：它用**你的飞书**读写你自己的多维表格，由 ReadLoop 服务计算每天该练什么。

数据存在你自己的飞书里，我们只提供规则和计算。

---

## 包里有什么

```
readloop/
├── SKILL.md                        主技能（首次使用先读「第 0 步：初始化」）
├── references/
│   ├── schema.md                   多维表格结构规范（建表依据）
│   ├── api.md                      接口契约
│   └── doubao-checklist.md         豆包工作冒烟测试（5 步）
└── README.md（本文件）
```

**第一次装到豆包工作，先按 `references/doubao-checklist.md` 跑完 5 个测试**，再谈真实使用。

## 前置条件

| 条件 | 豆包工作 | Codex / Work Buddy |
|---|---|---|
| bash + curl | ✅ | ✅ |
| 飞书能力 | **原生内置** | 需安装 `lark-cli` 并登录 |
| 需要飞书应用 | ❌ | ❌ |
| 需要把应用加成协作者 | ❌ | ❌ |

**不需要 MCP，不需要飞书开放平台应用。**

## 安装

把 `readloop/` 目录放到 AI 工具加载 skill 的位置；若该工具没有 skill 目录，直接把 `SKILL.md` 全文粘进自定义指令 / 项目规则，同样有效。

Codex / Work Buddy 需要先装飞书 CLI：

```bash
# 安装后按提示登录你自己的飞书账号
lark-cli auth login
```

## 首次使用

**前提**：你已经购买了 ReadLoop 的**年度授权**，手上有 8 位授权码。

对助手说：**初始化 ReadLoop**。它按顺序做五件事：

1. **首次激活** —— 粘贴授权码，换成本机凭证（有效期一年，到期前会提醒续费）
2. **选模型** —— 用你自己的模型 API（默认推荐 DeepSeek），需要 `base_url` / 模型名 / `api_key`
3. **建多维表格** —— 给表链接，没有就给你模板复制一份
4. **装 Chrome 插件** —— 采集入口，没有插件就没有新知识点
5. **建定时任务** —— 选每天还是每周、几点提醒（如 09:00 / 21:00），助手会直接用宿主的定时任务能力创建

五样齐了配置完成，之后直接说「今天练什么」。

配置文件：`~/.readloop/config.json`

```json
{
  "base_url": "https://readinsight.bamamei.online",
  "host_token": "...",
  "license_expires_at": "2027-10-23T00:00:00+08:00",
  "app_token": "KEjLbvKg7aT8RpsyDzBcIJbinhf",
  "model": {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "api_key": "sk-..."
  },
  "schedule": {
    "frequency": "daily",
    "time": "09:00",
    "weekday": null
  }
}
```

## 日常使用

- 说「今天练什么」或「开始练习」
- 也可以让 AI 工具建一个每日定时任务

## 常见问题

**问：豆包和 Codex 能同时用吗？**
能。各自装一次，读写的是同一张飞书表。

**问：换电脑怎么办？**
把 `~/.readloop/config.json` 复制过去。数据本来就在飞书里。

**问：会把我的表格数据传到你们服务器吗？**
不会传整张表。只传「当天候选知识点」用于选题出题，以及你当天的作答；服务不保存这些数据，也不保存表格内容。
当前版本的题面由服务端**确定性生成**，不调用模型；你的模型配置（含 `api_key`）随请求带上只是为将来的题面润色预留，服务不保存、不写日志。首次配置时，写入通道的三项校验由 ReadLoop 服务端自动完成（宿主不直接调飞书 OpenAPI）。
