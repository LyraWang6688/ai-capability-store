# investdesk / quote-sync

每交易日 20:00 把持仓最新价格写回飞书多维表格。

## 钟在哪（这是文件，不是概念）

| 文件 | 回答什么 |
|---|---|
| [`scripts/server-timers/systemd/investdesk-quote-sync.timer`](../../../../scripts/server-timers/systemd/investdesk-quote-sync.timer) | **什么时候** —— `OnCalendar=Mon..Fri *-*-* 20:00:00`，`Persistent=true`（关机错过会补跑） |
| [`scripts/server-timers/systemd/investdesk-quote-sync.service`](../../../../scripts/server-timers/systemd/investdesk-quote-sync.service) | 由服务器 dispatch 哪个 workflow |
| [`.github/workflows/automation-investdesk-quote-sync.yml`](../../../../.github/workflows/automation-investdesk-quote-sync.yml) | **跑什么** —— `node procedures/quote-sync/sync.ts` |

workflow 里**故意没有 `schedule`**：GitHub 的定时器在本仓库实测延迟 4-5 小时，
而这条链必须赶在次日 09:00 消费前落地。代价是没有兜底。

## 步骤

```
1-sync → procedures/quote-sync      Wind 取价 → 写回飞书 → 通知
```

## 部署

`deploy/` 里是把这个钟装上用的东西（systemd unit、plist 模板、服务器触发脚本、install.sh）。
它们描述**执行方式**，属于编排层；实现不在这里。

## 输出

写飞书「王颖的财富管理」Base 的「最新持仓」表（价格字段）。
抓不到价格的标的不写 0，保持原值并单独上报 —— 这条来自一次真实事故：
价格放在文本字段里、公式乘出来恒为 0，表格上显示成「负成本」。
