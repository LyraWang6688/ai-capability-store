# 投递箱 · 表契约

> **机器契约是 `scripts/target.json`。**本文档解释字段含义；两者冲突时以 `target.json` 为准。

## 表坐标

| 项 | 值 |
|---|---|
| Base | personal agent 养成系 |
| base_token | `ZNjDb9TrpalLuCsw0macCeVdnld` |
| table_id | `tblPOVjILsGdG9Uw` |
| 表名 | 投递箱 |

## 字段

| 字段 | id | 类型 | 谁填 | 说明 |
|---|---|---|---|---|
| `内容` | `fldWTmEU9C` | text | **提交者** | 结构化描述，必须按 SKILL.md 的模板写 |
| `类型` | `fldxMzrdTW` | select | **提交者** | 踩坑 / 经验 / 集成 / 偏好 / 事实 / 规则 |
| `来源项目` | `fldNjO222u` | text | **提交者** | 项目名或仓库名；非项目场景可留空 |
| `来源会话` | `fldjSXIYBt` | text | **提交者** | 执行者的 session id；不知道可留空 |
| `状态` | `fldvlTFbep` | select | **写入时自动** | 固定写 `待提炼` |
| `关联准则` | `fldESiwtwk` | text | **维护者** | 提炼后回填规则 ID（如 `G05` / `P001`），**提交者不要填** |
| `写入时间` | `fld7IkfTpc` | created_at | 系统 | 自动 |

## CellValue 格式

```jsonc
{
  "内容":   "字符串",
  "类型":   ["集成"],          // select 必须是数组
  "状态":   ["待提炼"],        // 必须显式写，不要依赖默认值
  "来源项目": "feishu-retail-ops",
  "来源会话": "可选"
}
```

## 写入

```bash
lark-cli base +record-batch-create \
  --base-token ZNjDb9TrpalLuCsw0macCeVdnld \
  --table-id tblPOVjILsGdG9Uw \
  --json @record.json --as user
```

> ⚠️ **payload 必须包一层 `{"create_records":[...]}`**。
> 直接传裸对象会报 `Unrecognized key(s) in object`。

## 失败排查

| 现象 | 原因 |
|---|---|
| `Unrecognized key(s) in object` | 忘了 `create_records` 外层 |
| `option not in table schema` | 用了不存在的类型或状态值 |
| `keychain Set failed ... operation not permitted` | **本机沙箱**未放行 `~/Library/Application Support/lark-cli/`，不是飞书故障 |
| 写入成功但立刻读回看不到 | Base 写操作异步，**最后统一读一次**，不要逐条读回 |
