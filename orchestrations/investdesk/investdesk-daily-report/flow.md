# 流程图 · investdesk-daily-report

```mermaid
flowchart LR
  A["价格同步完成"] --> B["发一条飞书消息（事件信号）"]
  B --> C["豆包侧监听"]
  C --> D["持仓日报"]
```
