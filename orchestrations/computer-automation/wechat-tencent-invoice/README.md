# computer-automation / wechat-tencent-invoice

在微信 macOS 桌面版里申请腾讯充值发票。**人发起**（`trigger: human`），没有钟。

## 步骤

```
1-invoice → skills/wechat-tencent-invoice
```

## 界面档案 · 微信 macOS 桌面版

| 项 | 值 |
|---|---|
| 入口 | 微信桌面端，已登录 |
| 驱动 | AX 树 + CGEvent + Vision OCR（屏幕录制 + 辅助功能授权） |
| **被什么挡住** | **AppleScript UI scripting 被系统拒绝（-10004）**，不要依赖它 |
| 前置 | macOS + 已登录微信 + swift/swiftc |
| **验证状态** | 见 skill 的「踩坑实录」；每次跑之前先确认授权还在 |

## 为什么这条是 Skill 不是脚本

要挑订单、核对抬头与金额、提交前必须人确认——每一步都在判断。
写成脚本会把"该确认"变成"直接提交"，那是这类操作最不能犯的错。
