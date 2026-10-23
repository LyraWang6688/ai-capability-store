# teaming-meeting-review（service-call）

**人问一场会 → 宿主取逐字稿 → 调分析服务 → 把报告链接交回。**

这条编排只有一步资产（`skills/teaming-meeting-analysis`），但它跨了一条系统边界：
SOP 正文里的 `curl` 打到一个**自建的后端服务**（`meeting.bamamei.online`）。
这一段没有 MCP、没有 CLI、没有插件承载它 —— 只有宿主的 shell 与网络。

```text
1-analyze  → skills/teaming-meeting-analysis
             └── calls: meeting-analysis-service
```

`calls` 不是 `use`：店外服务没有 `implementation_path`，不是可引用的落地资产。
它记的是「接口对应哪个后端服务」，契约必须与服务记录里那份是同一个文件。

---

## 三段

| 段 | 谁做 | 具体 |
|---|---|---|
| ① 取数 | 宿主自己的飞书能力 | 找会议、导出妙记**文字转录稿**（不要退化成 AI 摘要） |
| ② 闸门 | 宿主（模型判断） | 先本地判相关性；明显无关的**不上传** |
| ③ 调用 | 宿主 shell + 服务 | `POST /api/host/v1/analyze`，Bearer host token，`feishuMeetingId` 幂等 |
| ④ 交付 | 宿主自己的飞书能力 | 结论 + `reportUrl` 全文；用户要才发固定样式卡片 |

## 衔接规则（不属于任何一方，所以只能写在这里）

1. **数据出机是决策点，不是副作用。** 逐字稿一旦 POST 出去就出本机；所以上传前必须本地判一次相关性。定时扫描时没人可问，规则要更硬：明显无关的跳过，并在汇报里列出来。
2. **幂等键由宿主提供。** `feishuMeetingId` 必须传；不传的话服务端只能用逐字稿哈希当键，而同一场会每次导出的文本都有细微差异 → 同一场会被当成两场，重复分析、重复建行。
3. **超时不等于失败。** 首次分析 60~90s，`--max-time` 至少 150；超时后**重试是安全的**（幂等命中），不要换一份稿子重来。
4. **`not_abc_related` 不要重试。** 重试结果一定相同，只会白花一次调用。
5. **交付必须回到 GUI。** `reportUrl` 原样贴出来；卡片样式固定，不要自己设计。

## 前提

- 宿主能执行（`bash` + `curl`），并能出网到 `meeting.bamamei.online`
- 宿主具备飞书能力（取妙记）—— 服务不接触飞书，逐字稿由宿主导出
- 一个 host token：8 位接入码经 `POST /api/host/v1/enroll` 兑换，存 `~/.teaming-mcp/host-token`（600）

## 不做的事

- 不做会议摘要 / 待办 —— 那是宿主自己的纪要能力
- 不评价个人
- 不复制分析逻辑 —— 服务在独立仓库 `teaming-bot`，这里只有契约与引用
- 不负责触发（`trigger: human`）。同一 skill 还有「发现新妙记就自动分析」的定时用法，那是另一条编排，尚未登记
