# weread-reading-sync

把微信读书的**已读完**和**最近在读**同步到飞书多维表格（Base `ET2Bbx…`）。

确定性 procedure：判定口径写死在代码里，重复运行结果不变，可被 cron / skill / 人工调用。

## 跑什么

```bash
export WEREAD_API_KEY=wrk-xxxxxxxx          # 微信读书 Agent API key
export WEREAD_BASE_TOKEN=<飞书 Base token>   # 目标 Base（不入库，必须外部提供）
python3 collect.py --mode all            # 两张表都同步
python3 collect.py --mode finished       # 只同步「已读书籍」
python3 collect.py --mode reading --days 60   # 只同步「在读书籍」（窗口默认 60 天）
python3 collect.py --mode all --dry-run  # 只统计候选，不写库
```

输出一份 JSON 报告：`candidates / create / update / skip / elapsed_s`。

## 判定口径（不要改，改就是另一种口径）

| 分类 | 规则 |
|---|---|
| 读完 | `progress >= 98`（**不要求** `finishTime`） |
| 读完时间 | 优先 `finishTime`；缺失时退回 `readUpdateTime`（最近阅读） |
| 阅读链接 | 取 `/book/info` 的 `readerLink`（微信读书里直达该书的链接） |
| 分类 | **只取一级**：`个人成长-沟通表达` → `个人成长`（二级会让选项膨胀到 50+） |
| 在读 | 未读完，且 `readUpdateTime` 落在最近 N 天（**默认 60**，`--days` 可调） |
| 去重键 | 微信读书ID（bookId） |

三个真实反例，写测试时都覆盖了：

- 进度 98~99%、没有 `finishTime` → **算读完**。这是最常见的情况：书末的附录 / 后记 / 致谢被跳过，
  微信读书不会触发"读完"事件，所以有进度但没读完时间
- 进度 100%、没有 `finishTime` → **也算读完**，读完时间退回最近阅读时间
- 进度 97% → 不算（差太多）
- 有 `finishTime` 但进度回退到 98% → **不算读完**
- 最近打开过但进度 0% → **算在读**（这是真实行为，不是 bug）

## 前提

- `WEREAD_API_KEY` 环境变量（`wrk-` 开头）
- 本机 `lark-cli` 已 `auth login`，且对目标 Base 有编辑权限
- 目标两张表存在：已读书籍 `tblgcQ3l7bejHhwS`、在读书籍 `tblwkzfwOrFw1Mdz`
  （可用 `--finished-table` / `--reading-table` 覆盖）

## 什么情况下别用

- **想改"读完"的定义**（比如按 `finishReading` 标记算）——那就不是这个脚本了，口径变更要重写测试
- **想同步"订阅/等待上架"的书**——微信读书接口没有这个能力，只能人工维护
- **书已从书架移除**——接口取不到，脚本不会补（官方统计会比脚本结果多几本）

## 幂等与状态

- 以「微信读书ID」upsert，只写机器字段（书名/作者/分类/进度/时间/简介），**不覆盖人工填写的列**
- 两套缓存，各有自己的新鲜度规则（`state/` 已 gitignore）：

| 缓存 | 重查判据 | 理由 |
|---|---|---|
| `progress-cache.json` | 无缓存 / 书架 `readUpdateTime` 变了 / 超过 7 天 | 进度会变，靠书架信号触发 |
| `book-info-cache.json` | 无缓存 / 超过 30 天 | 书名作者分类简介基本不变，没必要每次重拉 |

- 性能：首次填缓存约 40 秒，热跑约 **7 秒**（不调 `/book/info`、只重查有新阅读的书）
- **别在几分钟内连续跑两次**：Base 的写入是异步生效的，第二次可能读到旧值而重复写同一批记录（不会写坏，只是白写）

## 状态迁移（自动删除）

书一旦读出 `finishTime`，会被**从「在读书籍」删除**——同一本书不该同时躺在两张表。

- 报告里 `left_reading_titles` 列出被删的书名，删什么有据可查
- `--dry-run` 会输出 `would_leave_reading` 预览，不删任何东西
- **只有能匹配到「微信读书ID」的行会被删**；人工新增且没有 bookId 的行永远不动
- 读了一半、超出窗口但没读完的书**不迁出**（状态没变，只是搁置）

## 测试

```bash
python3 test_collect.py       # 20 个用例，不联网、不写库
```

## 调度

```cron
# 每天早上 9 点同步
0 9 * * * cd /path/to/procedures/weread-reading-sync && WEREAD_API_KEY=... /usr/bin/python3 collect.py --mode all >> state/sync.log 2>&1
```
