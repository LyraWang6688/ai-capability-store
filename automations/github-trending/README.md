# github-trending

一个 **family** 容器，圈住两个共享文件的 automation。

| 成员 | registry key | 做什么 |
| --- | --- | --- |
| [`daily/`](./daily/) | `github-trending-daily` | 每天 05:17 采集 GitHub Trending → `data` 分支 |
| [`weekly/`](./weekly/) | `github-trending-weekly` | 每周日聚合一周快照，算 `star_delta` |

## 共享的文件

| 文件 | 作用 |
| --- | --- |
| [`REPORT-CONTRACT.md`](./REPORT-CONTRACT.md) | **报告长什么样**（权威版本，两个成员都按它执行） |
| [`interests.yaml`](./interests.yaml) | **关注清单**（报告的维度二靠它） |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 整条管线怎么跑、改一处影响什么 |
| [`render_report.py`](./render_report.py) | **渲染器**：content JSON → HTML |

这三份文件之前住在 `github-trending-daily/` 里，weekly 不得不伸进另一个 automation 的
目录去链接它们 —— 那是这次分成 family 的直接原因。

## 为什么这个容器没有 registry 条目

**family 是容器，不是资产。** 它没有 key、没有 version、没有 tag、没有 status、
没有 entrypoint，**没有任何东西执行它**。它的职责只有两条：

1. 装共享文件
2. 圈住它的成员

`scripts/validate_store.py` 强制这一点：

- registry key 必须等于 `<family>-<member>` —— 即 `github-trending` + `daily` → `github-trending-daily`
  （否则同一个东西会有两个名字，那正是校验器要防的漂移）
- 每个成员目录都必须已注册
- **这个 README 必须存在** —— 它是「为什么这些成员住在一起」的唯一记录

## 两个成员之间的关系

```
daily   产出数据   →  data 分支的 trending/<date>.json
                          ↓  weekly 读同一批文件
weekly  产出趋势   →  需要至少 3 天数据才敢下结论（trustworthy 门槛）
```

`weekly` 依赖 `daily` 的历史数据，这是它们必须放在一起的第二个原因。
