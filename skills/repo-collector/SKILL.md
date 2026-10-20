---
name: repo-collector
description: Collect high-value GitHub repositories surfaced in a conversation into the user's Feishu Bitable "GitHub 优质项目收录". Use when a chat mentions a repository worth keeping, or when the user asks to 收录 / 记录 / 收藏 / 查一下有没有收录 a repo, or to audit whether already-mentioned repos are in the table. Do not use it for non-GitHub links, for the other tables in the same base, or to write anything without explicit user confirmation.
---

# Repository Collector

把对话里出现的高价值 GitHub 仓库，规范化后收录进「GitHub 优质项目收录」多维表格。

> LLM 做语义判断。脚本保证事实与合规。人批准写入。

## Control flow

1. **SCAN** — 从对话中提取候选仓库 `owner/repo`。只收 GitHub 仓库；网站、文档站、Issue、搜索命中列表不是候选。
2. **VERIFY** — 跑 `scripts/repo_meta.py`。`Stars` / `Owner/组织` / `前端网页`（取自 `homepage`）/ 官方描述一律取回，**禁止凭模型记忆填写**。取不到就留空，不要估；`homepage` 指向 GitHub 仓库内部路径时也留空。
3. **DEDUPE** — 跑 `scripts/check_duplicate.py`。退出码 10 = 已收录，**停下来问人**（更新既有记录 vs 跳过），绝不插入第二行。
4. **CLASSIFY** — 按 [references/entry-style.md](references/entry-style.md) 写 `项目简介` / `核心亮点` / `参考价值`；按 [references/table-contract.md](references/table-contract.md) 选 `项目类型` / `主题标签` / `跟进状态`。
5. **VALIDATE** — 跑 `scripts/validate_record.py`。FAIL 就不许写入；按报错改，不要绕过检查。
6. **CONFIRM** — 把完整预览（每条记录的 11 个字段）展示给人，取得明确同意后才写。
7. **WRITE** — 用 `base +record-batch-create` 写入；同一张表串行写。
8. **VERIFY** — 回读刚写入的记录，确认字段真的落库正确，而不是只看写入接口返回成功。

## Routing

- 字段含义、写入命令、CellValue 格式、失败排查 → [references/table-contract.md](references/table-contract.md)
- 三段文案的写作标准、真实范例、反例、`跟进状态` 怎么定 → [references/entry-style.md](references/entry-style.md)
- 表坐标 / 字段 id / 枚举合法值 → `scripts/target.json`（唯一机器事实源）

## Scripts

| 脚本 | 作用 | 退出码 |
|---|---|---|
| `scripts/repo_meta.py <owner/repo>...` | 拉 GitHub 事实（stars / owner / 描述 / archived） | 0 成功，2 仓库不存在，3 限流 |
| `scripts/check_duplicate.py <owner/repo>...` | 查重（`Project` 列，大小写不敏感） | 0 全新，**10 已存在**，2 读表失败 |
| `scripts/validate_record.py <record.json>` | 写入前的 schema 门禁 | 0 合法，1 非法 |
| `scripts/test_scripts.sh` | 离线自测，无网络无写入 | 0 全绿 |

## 边界

- **只收录，不改表结构。** 不新增字段、不新增枚举选项。需要新分类时停下来问人，不要往 `target.json` 里加值。
- **不碰其他表。** 同一个 Base 下的 `Repository Registry` / `Repository Inventory` / `GitHub Snapshot` 都不在范围内。
- **不改不删既有记录。** 唯一例外是用户明确要求更新某条已收录记录。
- **不主动找仓库。** 只在对话里确实出现过候选时触发，不要主动去逛 GitHub 推荐。
- **不替用户拔高。** `跟进状态` 默认 `待深入`，不确定就留默认值。
- **批量上限。** 单次收录建议 ≤ 10 条；超过先确认范围。

## 依赖状态

运行依赖 `lark-cli`（飞书 Base 读写）与 GitHub REST API。二者目前都**没有**登记为 External Capability，
因此 `dependencies/capability-map.yaml` 未声明依赖，属 `DEPENDENCY_NOT_YET_REGISTERED`。
这与 `repo-hygiene` 的处理一致：外部能力注册表为空时，不制造虚假依赖记录。

## 本版本范围

v0.1 只覆盖「对话中已出现的 GitHub 仓库 → 规范化收录」这一条链路，
并以本仓库自身 `skills/shared/repo-collector/scripts/test_scripts.sh` 的离线测试
作为确定性安全证据。触发率、端到端轨迹、效率指标均**未评估**。
