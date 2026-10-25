# 流程图 · teaming-minute-scan-self-api

```mermaid
flowchart LR
  A["宿主定时叫醒"] --> B["扫描近期会议"]
  B --> C["teaming-meeting-analysis<br/>逐场分析"]
  C --> D["报告写回飞书"]
```
