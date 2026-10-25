# deepseek-invoice（作业登记处 · 实现已迁出）

> **实现不在这里。** 确定性的开票脚本与「DeepSeek 账单页」的界面档案都在
> [`computer-automation/browser-use/deepseek-billing/`](../../computer-automation/browser-use/deepseek-billing/)。

本目录现在只剩两样东西：

| 东西 | 为什么还在这 |
|---|---|
| `deploy/`（systemd unit + timer + install.sh） | 「谁跑、多久跑一次」属于编排层，本作业迁到 `orchestrations/automated/` 之前留在这里 |
| `run.mjs` → 软链 | 过渡用：`automations/registry.yaml` 要求 `entrypoint` 是**本目录内的文件名**，所以留一个指针让记录仍然成立。作业迁走时删掉。 |

## 部署

```bash
bash automations/deepseek-invoice/deploy/install.sh
```

`OnCalendar=*-*-01 10:00:00`，`Persistent=true`（错过会补跑）。

## 为什么是 systemd 而不是 github-actions

| 备选 | 为什么不行 |
|---|---|
| `github-actions` | 需要**长期登录态**且平台有**风控**；云端 runner 每次 IP 不同且在境外，会被判为可疑 |
| `launchd` | 目标机是 Linux，不是 macOS |
| `human` | 这是无人值守的月度定时任务 |

## 迁移计划

1. ~~实现搬到 `computer-automation/`~~（已完成）
2. 把本目录的 `deploy/` 与触发/输出契约迁到 `orchestrations/automated/deepseek-invoice/`
3. 删掉本目录与 `automations/registry.yaml` 里的这条记录

在完成第 2 步之前，**不要**删 `run.mjs` 这个软链——删了校验器会报
`automation deepseek-invoice entrypoint exists` 失败。
