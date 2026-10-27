# automated / dsh —— DSH 生态的自动化任务

> 模式说明见 [`../README.md`](../README.md)：定时任务 = 输入 + 处理 + 输出，输出必须是用户在界面上能看见的位置。
> 这个目录放 **DSH 生态**（`dsh/`）下的定时任务编排。

## 输出段落怎么算完成

对 DSH 生态，③ 输出的默认落点是：

```
服务器 / Actions 执行完 → 写「任务收件箱」→ DSH 面板出现「待读」→ 点开标已读
```

投递契约、两侧分工、验收清单写在独立文档里：

- 👉 [`COLLABORATION.md`](./COLLABORATION.md) —— 协作方案与投递契约（DSH 侧 / 任务侧）

## 目录约定

```
automated/dsh/
├── README.md            ← 本文件：这个生态的定时任务说明
├── COLLABORATION.md     ← 两侧协作方案与投递契约
└── <task>/              ← 具体任务的编排（README + 软链 + registry.steps 登记）
```

> 实现不放这里：收件箱插件在 `external-capabilities/plugin/dsh/inbox/`，
> 任务本体在 `automations/` 或对应仓库的 workflow 里。

## 相关

- 收件箱插件：[`external-capabilities/plugin/dsh/inbox/`](../../external-capabilities/plugin/dsh/inbox/README.md)
- 跟踪 issue：#295
