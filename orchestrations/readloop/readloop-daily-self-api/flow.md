# 流程图 · readloop-daily-self-api

```mermaid
flowchart LR
  A["宿主定时叫醒"] --> B["readloop<br/>取今日题目"]
  B --> C["服务端规则引擎<br/>选题 / 判分 / 间隔"]
  C --> D["状态写回用户的表"]
```
