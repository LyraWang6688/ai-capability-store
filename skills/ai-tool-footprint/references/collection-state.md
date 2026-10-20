# 首次追溯、增量积累与历史复用

## 持久材料

使用一个可持续找到的底稿目录，路径记录在每次交付中。不要按文章另建互不关联的历史库。

```text
ai-footprint/
  state.json          # 版本、时区、来源进度、历史运行
  evidence.jsonl      # 累计证据，一条事实一条记录
  stories.jsonl       # 实践成果、经验和待确认故事
  articles.json       # 历次主题、证据引用、成稿与发布状态
  runs/<run-id>/      # 本次来源摘要、错误和必要脱敏快照
```

沿用用户已有等价结构即可；不要为了格式迁移丢弃旧底稿。首次引入旧报告时标记 `legacy_unverified`，保留原路径和日期；报告生成日不等于各来源采集截止，不能直接用来推进检查点。

## 时间与状态

使用带时区的 ISO 8601 时间，默认 Asia/Shanghai。运行开始固定 `cutoff`，采集按 `[from, cutoff)`，下一次从该 cutoff 开始。首次 `from=null` 表示查询全部可见历史，而非无限历史。

```json
{
  "schema_version": 2,
  "timezone": "Asia/Shanghai",
  "sources": {
    "chrome:Default": {
      "last_successful_cutoff": "2026-10-20T10:00:00+08:00",
      "last_attempt_status": "success",
      "observed_coverage": {"from": "2026-07-06T09:00:00+08:00", "to": "2026-10-20T09:50:00+08:00"},
      "run_id": "20261020-100000"
    },
    "sessions:codex": {
      "last_successful_cutoff": null,
      "last_attempt_status": "permission_denied",
      "error": "读取失败，待补采"
    }
  },
  "runs": []
}
```

按真正可独立采集的来源分检查点，例如浏览器配置文件、邮箱账户、会话产品。状态包含 success、no_matches、permission_denied、parse_error、partial、not_collected。`no_matches` 只有在完整查询成功时才能推进截止点；其余失败、截断或未采集不推进。`observed_coverage` 是数据实际首末，区别于成功查询到的截止时间。用本次 attempt 元数据保留 from/cutoff、过滤规则、截断与错误。

## 执行规则

1. 读取既有状态；新来源独立做首次追溯。来源曾失败，下次从它自己的旧截止点继续，不跳到其他来源的进度。
2. 优先按来源内的事件时间增量查询。会话旧文件可能追加消息，不能只按新文件筛选；无事件索引时检查近期变动文件，再逐条按事件时间过滤。此类回退在运行记录中说明。
3. 可回看最近数天以吸收迟到或修订记录；历史补查使用单独 backfill 范围，不回退正常检查点。mtime 只能帮助发现变动，不能替代事件时间。
4. 使用稳定来源标识去重（会话/消息 ID、浏览器访问 ID 等）；无 ID 时对来源、工具、事件时间、事件类型和规范化必要字段生成稳定摘要。扫描发现时间不参与主键。重复扫描不累加；变更记录保留修订信息。
5. 先持久保存证据及运行摘要，再以临时文件加原子替换更新 state；失败重试依靠稳定 ID 去重。不要同时运行两个写同一底稿的采集任务。
6. 检查点独立于文章是否完成或发布。文章未写完不会导致证据重新全采；文章发布也不能代替采集完成。

证据记录至少含 id、source、tool、event_type、occurred_at（不详则 null）、discovered_at、run_id、source_ref、必要事实、核验状态。日期只有月份时记录精度 month，不补造具体日时；不能仅凭月份判定边界覆盖完整。

人工输入与自动任务能区分时分别记录，不能把后台自动运行全部说成人工使用。

## 文章复用

articles.json 记录文章 ID、主题、叙事起止、所用 evidence/story IDs、采集快照或 run IDs、成稿日期、发布状态及已知发布日期。发布时间未知则为空。参考历史文章选择新增成果或不同角度；允许长期回顾复用历史案例，不必完全排重。

例：10 月首次追溯全部可见历史；11 月补 10 月截止后的记录；次年 4 月若 11 月已成功采集，则从 11 月截止继续。半年文章可以讲 2024 年至今，使用累计底稿。失败来源单独补齐。
