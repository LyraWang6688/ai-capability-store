# computer-automation —— 操作一个界面

这个项目收的是**「这件事只能靠操作界面完成」**的作业：没有 API、没有 CLI，
只能像人一样点。

一条任务一个文件夹。**承载方式不限**：

| 任务 | 载体 | 为什么 |
|---|---|---|
| `deepseek-invoice` | `procedures/deepseek-invoice`（确定性脚本） | 流程确定：读金额 → 填表 → 提交，全都能写成代码 |
| `wechat-tencent-invoice` | `skills/wechat-tencent-invoice`（判断） | 要挑订单、核对抬头、提交前必须人确认 |

**同一个项目里两种载体并存，这不是不一致，是选择对了。** 判据是"这一步需不需要判断"，
不是"它属于哪个项目"。

## 手册区：`manuals/`

任务之外，这个项目还收**操作手册**——「系统没给 API/CLI 时怎么驱动它」：

| 目录 | 收什么 |
|---|---|
| [`manuals/browser-use/`](./manuals/browser-use/) | 浏览器操作（CDP / MCP / Playwright） |
| [`manuals/computer-use/`](./manuals/computer-use/) | 桌面操作（截屏 / AX / CGEvent / AppleScript） |

`manuals/` 是项目下**唯一允许的非任务目录**：不登记 `registry.yaml`、不进 tag、
只要求自带 README 说明自己（校验器 `ORCHESTRATION_DOC_DIRS` 按名字放行）。
规矩写在 [`manuals/README.md`](./manuals/README.md)，写入口是 `skills/computer-automation-log`。

**为什么放在这个项目里**：手册的内容是"怎么操作界面"，它服务的正是这个项目里的任务。
拆开放两个域，读者找"这个项目怎么跑"时会漏掉前置的手册；而把它做成任务又会污染 registry
（一份手册没有 `trigger`、没有 `output`）。

## 这里的资产为什么特殊

界面失效是**静默的**：API 改了会报错，CLI 改了会报错，界面改了只会让脚本
"看起来做了但其实没做"。所以每条任务的 README 里必须有一节 **验证状态**：
上次实测是哪天、当时结论是什么、什么情况下要复核。手册区同理——抬头四条的「结论」不写
「已验证」的，别照着做。

## 与别的域的关系

```
skills/               需要判断的界面操作（wechat-tencent-invoice）
procedures/           确定的界面操作（deepseek-invoice）
orchestrations/       本目录：什么时候跑、按什么顺序、产出落哪
  └── manuals/        本项目的操作手册（不是任务，不进 registry）
```
