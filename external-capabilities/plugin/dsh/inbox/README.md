# @lyra_wang/dsh-inbox

**DSH 收件箱面板**：把飞书多维表格「任务收件箱」里的未读任务，在 DSH 里变成一个待读面板。

服务器上的定时任务执行完后，往飞书表写一行（状态=未读）；你打开 DSH 时，面板自动弹出未读列表，点开即标记已读。

## 能力

| 能力 | 说明 |
|---|---|
| 📥 输入框按钮 | 显示未读数红点，点击打开/关闭面板 |
| 自动弹出 | DSH 启动后拉一次，有未读则自动弹面板 |
| 未读列表 | 任务名（关联「定时任务」表解析）、执行时间、结果徽标、结果摘要 |
| 点开已读 | 点击一条 → 调 Host 路由把飞书表该行状态改成「已读」，并从面板移除 |
| 全部已读 | 一键把当前未读全部标记 |
| 轮询 | 打开 App 期间每 30 分钟刷新 |

> 和「任务侧」的分工与投递契约属于编排层：见
> [`orchestrations/scheduled-task/dsh/COLLABORATION.md`](../../../../orchestrations/scheduled-task/dsh/COLLABORATION.md)。

> 定时任务侧与本侧的分工、投递字段契约，见编排层文档：
> [`orchestrations/scheduled-task/dsh/COLLABORATION.md`](../../../../orchestrations/scheduled-task/dsh/COLLABORATION.md)。

## 架构

```
Client（面板 UI）  ──同源 fetch──▶  Host 路由  ──lark-cli──▶  飞书 Base
   conversation.input.left            /plugins/inbox/list
   shell.overlay                      /plugins/inbox/read
                                      /plugins/inbox/deliver   ← 服务器/脚本投递用
```

- 表坐标默认写死为「项目管理」Base 的「任务收件箱」（`tbl9LghPBTjFLH4N`），可用环境变量覆盖：
  `DSH_INBOX_BASE_TOKEN` / `DSH_INBOX_TABLE_ID` / `DSH_INBOX_TASK_TABLE_ID` / `DSH_INBOX_IDENTITY`。
- 所有访问都通过操作者本机已授权的 `lark-cli`，插件本身不存任何凭据。
- Host 路由全部经过 DSH 连接鉴权（`connection.requestRejection`）。

## 投递（给服务器/脚本用）

```bash
curl -X POST http://127.0.0.1:<port>/plugins/inbox/deliver \
  -H 'content-type: application/json' \
  -d '{"summary":"扫描 12 个仓库，3 个有风险","result":"成功","taskRecordId":"reczz28QAltif1ha"}'
```

> 需要带上 DSH 的浏览器会话（连接鉴权）；服务器侧由 runner 用同机回环 + token 调用。

## 安装

```bash
dsh plugin --profile desktop add @lyra_wang/dsh-inbox
# 然后把 @lyra_wang/dsh-inbox 加进 profile 的 dsh.profile.bundles
```

## 版本

- 0.1.0：Host 路由 + Client 面板（按钮/弹窗/标已读/轮询）
- 0.1.1：投递改用 `+record-batch-create`（lark-cli 没有 `+record-create`）
- 0.1.2：去掉 patch 里的 config（插件不声明 schema，传 config 有挂载风险）；坐标改由环境变量覆盖
- 0.1.3：修正 Base token（收件箱表在「项目管理」Base）；本机实测通过
