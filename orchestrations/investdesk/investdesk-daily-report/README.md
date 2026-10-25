# investdesk-daily-report（豆包 Work 侧）

> 名字避开 `investdesk-quote-sync` —— 那是 automation 的名字，
> 编排和它同名会让 tag 也同名（`investdesk-quote-sync-v0.1.0` 已经属于 automation）。
> 这条编排编的是「日报接棒」，不是价格同步本身。

**价格同步跑完之后，不要让人再去叫一次持仓日报。** 这条编排把"同步完成"变成一个
事件，让豆包接住。

```text
1-trigger-and-execute  → automations/investdesk-quote-sync
2-consume              → skills/investdesk-portfolio
```

---

## 这条链长什么样（按三段看）

```text
① 输入  服务器 crontab（工作日 20:00）
② 处理  GitHub Actions 取价 → 写飞书 Base → 发飞书消息
③ 输出  飞书私聊：持仓日报（豆包生成后推给用户）
```

**段间两处连接，性质不同：**

| 位置 | 类型 | 说明 |
|---|---|---|
| 服务器 → GitHub Actions | **直连** | 调 `workflow_dispatch` 接口 |
| Actions → 豆包 | **桥** | 豆包没公网入口，Actions 调不到它 → 用飞书消息，豆包监听关键词来取 |

**所以这条链只有 1 个桥，不是"5 步"。** 下面的分段是这条链的具体走法，供排障用：

```text
① 服务器 crontab 准点敲钟          ← 不用 GitHub 的 schedule：
   POST workflow_dispatch            实测延迟 4-5 小时（"QUEUED FOR 4h14m"）
        ↓
② GitHub Actions 跑价格同步
   取价（Wind）→ 写飞书 Base「持仓价格表」
        ↓
③ 发一条飞书单聊消息给「万能助手」
   automation 内部的 src/notify.ts，独立凭证 NOTIFY_APP_ID/SECRET
        ↓
④ 豆包监听这条消息，按关键词命中
        ↓
⑤ 触发 skills/investdesk-portfolio 生成持仓日报
```

**为什么前 3 段合成一个步骤**：它们都在 `automations/investdesk-quote-sync` 内部
（`sync.ts` 串起来），没有对应的独立资产可以指。硬拆成三步会给每个 `use:` 编一个
不存在的路径 —— 那比"这里是一步"更糟。

---

## ⚠️ 衔接规则：关键词是这条链的接口

```text
notify.ts 第 10 行：
  "文案固定包含触发关键词「持仓价格同步完成」，豆包事件监听按它命中。"
        ↓
【改这句文案 = 断链】
```

**这是两个资产之间的事，不属于任何一方** —— 所以它只能待在这里。

那两句话分别写在：

| 谁 | 写的什么 |
|---|---|
| `automations/investdesk-quote-sync/src/notify.ts` | 固定文案「持仓价格同步完成」|
| 豆包侧的监听规则 | 按这个关键词命中 |

改任何一边，都必须同时改另一边。

---

## 为什么是事件推送，不是两个定时任务

```text
老做法：21:00 定时跑日报
  → 价格同步可能还没完成（甚至因为 GitHub 调度延迟到次日 01:00）
  → 日报用的是旧价格

现在：同步完成 → 发事件 → 事件到了才生成日报
  → 日报永远是对的价格
  → 而且同步失败就不会有日报（比"生成一份错的"好）
```

**notify.ts 的注释里原话**：「事件推送型，替代固定 21:00 定时」。

---

## 不做的事

- 不复制取价 / 写表 / 发消息的逻辑
- 不重写触发关键词（它在 notify.ts 里）
- 不负责定时（那是 `automations/` 的 deploy/ 目录）
