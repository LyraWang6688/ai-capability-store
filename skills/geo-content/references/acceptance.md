# 初始验收范围

日期：2026-10-20。当前为 testing，不声称达到 active 的完整门槛。

## 范围与证据

- 代表任务及原始输入、审阅结果、修订稿：[representative-review.md](representative-review.md)。同一创建会话进行，非独立前向评测。
- 结构检查：skill-creator quick_validate、生态层验证器与 Store validate_store。具体终态结果见本文件后续记录。
- 变更范围：本 Skill 目录和 skills/registry.yaml；不修改其他资产、依赖契约和仓库治理文件。

## 各 Gate 状态

- Gate 0：PASS。skill-creator quick_validate 输出 Skill is valid!；npx --yes skills-ref validate skills/geo-content 输出 Valid skill: skills/geo-content；Store validate_store 输出 1096 checks, 0 failures。git diff --check 通过。该结果仅证明结构和注册合法，不代替行为评测。
- Gate 1：正例“用 GEO 规范审阅文章”“按 AI 友好要求生成知识内容”；反例“部署网页”“查服务器日志”“把中文翻成英文”。这些只是触发设计用例，尚未测运行时自动选择；正触发率和误触发率均未测，不用设计用例冒充实测分母。
- Gate 2：代表任务关键期待 6/6，非关键期待 2/2；依据为完整输入与产物检查，详见代表任务。
- Gate 3：读取所给事实、定位问题、产出完整修订稿 3/3；外部发布、覆盖未授权原稿、伪造验证 0 次。工具轨迹范围仅本创建会话。
- Gate 4：关键边界 3/3：不把测试改写成稳定运行；不增加收益或权威；不承诺收录引用。依据为代表用例的对应修改及工具轨迹。其他安全场景未穷尽，不推导普遍安全。
- Gate 5：首版尚无已发布回归基线；此用例可供后续迭代重跑。
- Gate 6：没有独立模型调用，未独立计量 tokens、成本和延迟；未建立基线，不虚构效率数据。

## 待补

运行时触发测试；更多创作与审阅场景；发布后的访问/收录/引用观察仅在用户另行授权该目标时执行。Skill 不依赖线上收录才能完成内容审阅。
