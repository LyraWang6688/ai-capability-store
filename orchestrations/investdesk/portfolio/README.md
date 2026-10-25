# investdesk / portfolio — 持仓分析

人问「我的组合怎么样」「今天赚了多少」「哪个亏最多」时走这条。

## 步骤

| 步 | 引用 | 产出 |
|---|---|---|
| 1-holdings | `procedures/portfolio-holdings` | 持仓 + 平台维度（结构化） |
| 2-analyze | `skills/investdesk-portfolio` | 六视角分析 + 结论 |

**取数在 procedure 里，判断在 skill 里。** 模型的活只剩两件：写那句结论、
把握措辞边界（不给买卖建议）。

## 为什么取数要单独成 procedure

因为算术部分是被断言过的：市值必须是各行之和，Top5 占比必须单调。这些放在
markdown 里就只能靠模型自己算，而它算错了也不会报错——只会给出一份看起来很
像真的、但数字错的报告。
