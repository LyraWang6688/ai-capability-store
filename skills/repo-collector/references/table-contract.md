# 目标表契约 — GitHub 优质项目收录

## 表坐标

| 项 | 值 |
|---|---|
| Wiki 入口 | `https://my.feishu.cn/wiki/P3qAws8yjiU4eSkJDfTcYEbJnlg` |
| 表名 | GitHub 优质项目收录 |
| base_token | `NeujbbOfcaPEvMsPIxscaJImn9d` |
| table_id | `tblenXNEDtNtVIf4` |

> **坐标、字段 id、枚举合法值一律以 [`../scripts/target.json`](../scripts/target.json) 为准。**
> 本文档解释「每个字段是什么意思、该怎么写」；`target.json` 是机器事实源。
> 两者冲突时，`target.json` 胜出，`validate_record.py` 按它强制执行。

## 读

```bash
# 列出全部已收录的 Project（查重的事实来源）
lark-cli base +record-list \
  --base-token NeujbbOfcaPEvMsPIxscaJImn9d \
  --table-id tblenXNEDtNtVIf4 \
  --field-id fldtln9yqr --as user --format json

# 导出全部记录用于比对
lark-cli base +record-list \
  --base-token NeujbbOfcaPEvMsPIxscaJImn9d \
  --table-id tblenXNEDtNtVIf4 \
  --format ndjson --output ./records.ndjson --as user
```

## 写

```bash
lark-cli base +record-batch-create \
  --base-token NeujbbOfcaPEvMsPIxscaJImn9d \
  --table-id tblenXNEDtNtVIf4 \
  --json @record.json --as user
```

单批最多 200 条；同一张表**串行写入**，并行会触发 `1254291` 并发冲突。

## 字段语义

`role` 决定这个字段由谁负责：

- `fact` — 必须来自 `repo_meta.py` 的返回值，**禁止凭模型记忆填写**
- `identity` — 查重的主键
- `classify` — LLM 语义判断，取值必须落在 `target.json` 的 `options` 内
- `narrative` — LLM 写作，标准见 [entry-style.md](entry-style.md)
- `link` — 由 `identity` 机械生成，禁止手写

| 字段 | role | 怎么写 |
|---|---|---|
| `Project` | identity | `owner/repo` 原样。跨字段校验：`Repository URL` 必须与它严格对应 |
| `Repository URL` | link | 由 `target.json` 的 `url_template` 用 `Project` 生成，形如 `[owner/repo](https://github.com/owner/repo)` |
| `前端网页` | fact | 只有**真实网页**才填，形如 `[skills.sh](https://skills.sh)`。事实来源 = GitHub API 的 `homepage`；为空、或指向 GitHub 仓库内部路径（`https://github.com/...`）时**留空**，不要拿目录页/文档页凑数 |
| `Owner/组织` | fact | GitHub 的 `owner.login`（组织或用户）。不要写产品名，不要翻译 |
| `Stars` | fact | GitHub 的 `stargazers_count` 数字。**不确定就不填，不要估** |
| `项目类型` | classify | 该仓库在生态里的**角色定位**，单选 |
| `主题标签` | classify | 该仓库**涉及的技术面**，多选；一条通常 2–4 个，不要凑满 |
| `跟进状态` | classify | 用户对它的**处置意图**，不是项目质量。默认「待深入」 |
| `项目简介` | narrative | 一句话说清它是什么 |
| `核心亮点` | narrative | 具体到技术机制，不是形容词 |
| `参考价值` | narrative | 对**用户自己的 Store** 意味着什么 |
| `收录日期` | fact | ISO-8601 带时区；默认收录当天 `T00:00:00+08:00` |

`项目类型` 的取值维度（合法值见 `target.json`）：工具/命令 → CLI 工具；服务目录 → 注册中心；协议/标准/RFC → 规范协议；个人资产仓库 → 个人 Skill 库；大而全的实验 → 综合实验。

## CellValue 格式速查

```jsonc
{
  "text":     "字符串",
  "select(单选)": ["唯一选项"],          // 必须是数组，且恰好 1 个
  "select(多选)": ["选项A", "选项B"],    // 数组，取值必须在 options 内
  "number":   32980,                    // 纯数字，负值会被 validate_record.py 拒绝
  "datetime": "2026-10-03T00:00:00+08:00"
}
```

## 失败排查

| 现象 | 原因 |
|---|---|
| `validate_record.py` FAIL: option not in table schema | 用了表里不存在的选项；不要新建选项，改用已有语义最近的 |
| FAIL: Repository URL must be exactly ... | 链接和 `Project` 不一致，或多写了 `www.` / 尾斜杠 |
| FAIL: unknown field | 写了表里没有的列；不要臆造字段 |
| `check_duplicate.py` 退出 10 | 已收录。停下来问人：更新既有记录，还是跳过 |
| lark-cli 报 `permission_denied` | scope 或表权限问题，按 `lark-shared` 处理；不要改用 bot 身份绕过 |
