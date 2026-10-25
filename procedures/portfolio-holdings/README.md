# portfolio-holdings — 取持仓

从飞书多维表格取出持仓与平台维度，输出结构化 JSON。

**这是 investdesk 的「取数」那一段**，原来埋在 `automations/investdesk-quote-sync/src/feishu/` 里，
没有任何身份：不能单独跑、不能测试、不能被第二处引用。搬到这里之后，它有两个消费者：

| 消费者 | 用它做什么 |
|---|---|
| `automations/investdesk-quote-sync` | 取需要报价的标的 → Wind 取价 → 写回 |
| `skills/investdesk-portfolio` | 取数 → 六视角分析（skill 变薄，不再让模型读表） |

## 跑

```bash
node dump.ts        # 打印 { count, platforms, holdings } 的 JSON
```

环境变量（与 automation 共用同一套，见
[config.ts](../../automations/investdesk-quote-sync/src/config.ts)）：

```
INVESTDESK_BASE_TOKEN · INVESTDESK_HOLDINGS_TABLE · INVESTDESK_PLATFORMS_TABLE
FEISHU_APP_ID · FEISHU_APP_SECRET
```

## 文件

| 文件 | 作用 |
|---|---|
| `dump.ts` | 入口：取一次持仓并打印 |
| `src/holdings.ts` | `listHoldings` / `listPlatformNames` / `listHoldingTargets` / `updateLatestPrices` |
| `src/openapi.ts` | 飞书 OpenAPI 客户端（tenant_access_token、分页、批量读写） |
| `src/backend.ts` | 客户端类型 |

## 为什么依赖 automation 的 config

**先把位置放对，再谈参数化。** 现在两个消费者跑在同一台机器、读同一套环境变量，
配置作为参数传进来没有任何收益；等出现第二个部署环境（比如把分析搬到别处跑）时再改，
那时代价一样，但不会为想象中的需求提前抽象。

## 纪律

这个 procedure 的契约是**同样的表数据必须产出同样的 JSON**。现在还没有测试夹具 ——
补测试时的做法：把一次真实响应脱敏后存成 fixture，断言字段映射与空值处理，
断言"读不到数量时按缺失上报而不是当 0"（这条来自一次真实事故：价格缺失被当成 0，
表格上显示成负成本）。
