# readloop-daily-self-api（-self-api：调自建 API）

**宿主定时叫醒 → 读表 → 服务算今日题 → 一次一题 → 服务判分 → 写回表。**

和 `teaming-meeting-review-self-api` 同为调自建 API 的编排，但拓扑不同：这条是**闭环**。
状态不在店里、也不在服务里 —— 在**用户自己的多维表格**里；服务只做计算，不存数据。

```text
1-coach  → skills/readloop
           └── calls: readloop-service
```

---

## 三段

| 段 | 谁做 | 具体 |
|---|---|---|
| ① 取数 | 宿主自己的飞书能力 | 读 `knowledge_points` 里非 `mastered` 的行 |
| ② 计算 | 服务（确定性规则） | `POST /api/review/today` → 题目（不含答案）+ `session_context` |
| ③ 交互与写回 | 宿主 | 一次一题；`POST /api/review/submit` → `result` + `updates`；把 `updates` **原样**写回 |
| ④ 交付 | 宿主 | 今日总结只用 `session_context` 里的数字 |

## 衔接规则

1. **agent 是嘴，不是脑子。** 判分、间隔、下次复习时间都由服务决定；skill 里明令不许自己算、不许改判。
2. **读写表只用宿主自己的飞书能力**，不要用 `curl` 调飞书 OpenAPI（没有应用凭证，也不该有）。
3. **数据最小出机**：只传当天候选知识点，不传整张表；服务不保存这些数据。
4. **402 只提示续费**：不清配置、不重装、数据不动。401 才重新用授权码兑换。
5. **定时段只预览 1 题**：用户不在场时，不一次列出全部题目。

## 前提

- 宿主能执行（`bash` + `curl`），并能出网到 `readinsight.bamamei.online`
- 宿主具备飞书能力（豆包原生，或安装并登录 `lark-cli`）
- 一个 host token：8 位授权码经 `POST /api/license/activate` 兑换，存 `~/.readloop/config.json`（600）
- **首次配置自举**：这条编排的钟不是 `automations/` 里的 automation —— 是 skill 在首次配置时用宿主自己的定时任务能力创建的（读回校验后写进 config 的 `schedule` 段）。所以 `trigger: host-schedule` 是一个**运行时产生**的事实，不是登记时就固定的 cron。
- readloop skill 0.2.0 起，首次配置的写入校验由服务端代跑，**宿主不再 `curl open.feishu.cn`**；插件直连飞书是浏览器那侧的事，不算这条链的出网 —— 所以 `execution.egress` 只有 `readinsight.bamamei.online`。

## 不做的事

- 不自己出题、不自己判分、不自己算间隔
- 不自己建表 / 改表结构
- 不把用户数据存到服务端（也不该在别处备份）
