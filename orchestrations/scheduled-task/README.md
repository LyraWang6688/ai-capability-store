# scheduled-task —— 钟来叫的任务

这个**模式**的通用流程是**五段**。每一段回答一个固定的问题，不管具体任务是什么。

```text
① 敲钟        服务器 crontab
② 执行        GitHub Actions
③ 推事件      飞书
④ 消费        豆包 / DSH 监听
⑤ 执行 skill  产出结果
```

---

## ⚠️ 具体编排不必凑够五段

一个 automation 可能把 **②③④ 全包在自己内部** —— 那它们就没有独立的资产可以指。

> **通用层面提到就够了。具体层面只写能引用的。**

以 `doubao-work/investdesk-daily-report` 为例：

| 通用段 | 在具体编排里落在哪 |
|---|---|
| ① 敲钟 | `scripts/server-timers/timers/investdesk-quote-sync.cron` |
| ② 执行 | `automations/investdesk-quote-sync/.github/workflows/…yml` |
| ③ 推事件 | `automations/investdesk-quote-sync/src/notify.ts` |
| ④ 消费 | 豆包侧监听（**不在本仓库**）|
| ⑤ 执行 skill | `skills/investdesk-portfolio` |

**①②③ 共享同一个 `use:`** —— 它们都在 `automations/investdesk-quote-sync` 内部，
拆成三步会给每个 `use:` 编一个不存在的路径，比"这里是一步"更糟。
**④ 没有资产可指** —— 监听规则在豆包那边，本仓库只记录"衔接靠关键词"这条事实。

所以那条编排的 `steps` 只有 2 段：

```yaml
- id: trigger-and-execute   # ①②③
- id: consume               # ④⑤
```

**五段是流程的骨架，`steps` 是可校验的落点。两者不是一回事。**

---

## 五段里最容易断的地方

```text
② → ③   执行完不一定发得出事件（notify 失败只警告，不阻塞主流程）
③ → ④   靠一段固定文案：「持仓价格同步完成」
④ → ⑤   靠豆包的监听规则命中那个关键词
        ↓
【改文案 = 断链，且不会报错】
```

这类"两个资产之间的事"写在各条编排的 README 里，因为不属于任何一方。
