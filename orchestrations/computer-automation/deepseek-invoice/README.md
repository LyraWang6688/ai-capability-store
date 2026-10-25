# computer-automation / deepseek-invoice

每月 1 日给 DeepSeek 开放平台账户的余额申请企业增值税普通发票。

## 步骤

```
1-run → procedures/deepseek-invoice
```

## 界面档案 · DeepSeek 开放平台账单页

| 项 | 值 |
|---|---|
| 入口 | `https://platform.deepseek.com/transactions` |
| 驱动 | headless Chromium + Playwright（本机无已登录 Chrome 可用） |
| 会话 | `storageState`（cookie + localStorage 的 userToken，约 6KB，权限 600） |
| 前置 | 国内固定出口 IP（平台按 IP 风控）；`config.json` 里的抬头/税号/邮箱 |
| 结构 | 金额在 `.ds-text / span / div` 最内层节点，形如 `¥1,234.00`；抬头是自研自动补全，**必须点下拉第一项** |
| **验证状态** | `verified 2026-10-23` —— 金额读取与失败分支已实测；**「有额度」真实提交尚未真机验证**，首次请人工旁看 |

## 失败处置（这是这条任务的全部重点）

| 退出码 | 含义 | 动作 |
|---|---|---|
| 0 | 成功，或金额明确为 0 已跳过 | — |
| 2 | 登录失效 | 重新导出登录态 |
| 3 | 超过 `maxAmount` 上限 | 人工确认 |
| **4** | **读不到金额**（改版 / 未加载） | 截图已存；**不要当 0 跳过** |
| **5** | **提交后未验证到成功** | 人工核对，**不要自动重提** |

4 和 5 都来自真实事故：前者曾把"读不到"当"没有额度"静默跳过一个月；后者重提会重复开票。
