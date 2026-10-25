# 换一台 Mac 之前 —— 跨设备清单

> 这份文件回答一个问题：**别人把 skill 拿走，在他自己的 Mac 上能不能跑？**
> 实测基线：macOS 27.0.1 / 微信 4.1.13 / 1280×828 @2x / 单屏 / 中文界面 / **Apple Silicon（arm64）**。
> **架构范围：只支持 arm64。** Intel（x86_64）不在支持范围 —— `build.sh` 与 `ui doctor` 会直接拦下，
> 不会装作能用。
> 换设备时，按本文十节逐项过一遍；每节都写「不符会怎样」，因为 GUI 失效不会报错。

## 1. 系统与微信版本

| 项 | 实测 | 不符会怎样 | 怎么做 |
|---|---|---|---|
| macOS | 27.0.1 | 更低版本也能跑（CGEvent/AX/Vision 都是老 API），但没实测 | 先跑 `ui doctor`，FAIL 就停 |
| 微信 | 4.1.13（`CFBundleShortVersionString`） | 小程序与 H5 的文案/布局可能变，锚点文字对不上 | 每步的「观察点」找不到就停，不要连点；按当前界面重新确认一次再更新本文件 |
| 微信语言 | 中文 | 英文界面的按钮文案不同，全部锚点失效 | 本 skill 只适用于中文界面 |
| 登录账号 | 用户自己的微信 | 订单/可开票金额因人而异 | 绝不照抄文档里的金额与笔数 |

## 2. 依赖（缺一不可）

| 依赖 | 检查 | 缺了会怎样 | 怎么装 |
|---|---|---|---|
| `swiftc` | `command -v swiftc` / `ui doctor` | `ui` 编译不出来，整个 skill 没有驱动工具 | `xcode-select --install`（约 1–2 GB）。**注意：拿「预编译包」时不需要它**——包内已带 `ui`；只有源码包或跨架构（arm64 ↔ x86_64）才要重编 |
| 微信 macOS 版 | `ui doctor`（按 bundle id 查） | 没有界面可操作 | App Store / 微信官网 |
| 网络 | 打开小程序/客服页 | 页面空白或一直加载 | 本文不负责，属环境问题 |
| 支持读图的宿主 | 模型能否看图 | 系统 OCR 挂掉时无法降级定位 | 换多模态宿主（DSH / Codex / Claude 等） |

**不需要**：MCP server、DSH 插件、Node、Python、pip/npm 包。`ui` 只依赖系统框架（CoreGraphics / ApplicationServices / AppKit / Vision）。

## 3. 权限：授给「运行 Agent 的宿主程序」

TCC 认的是**发起操作的那个 app**，不是 `ui` 这个命令行工具。所以要在系统设置里勾选**你用来跑 Agent 的程序**（Terminal、iTerm、DSH、Codex、ChatGPT 桌面版……），勾完**重启它**。

| 权限 | 用在哪 | 没给会怎样 | 位置 |
|---|---|---|---|
| 辅助功能（Accessibility） | 合成点击/键盘、AX 窗口动作 | **点击静默无效**：不报错、页面不动，最容易被误判成「页面卡住」 | 系统设置 → 隐私与安全性 → 辅助功能 |
| 屏幕录制（Screen Recording） | `screencapture` 截图 | 截图黑图/写不出文件 → 后面所有定位落空 | 系统设置 → 隐私与安全性 → 屏幕录制 |
| 剪贴板 | `pbcopy` + ⌘V 填中文 | 中文填不进输入框 | 无需授权；被剪贴板管理软件拦截时改用 `ui type` |

**不需要「自动化（Apple Events）」**：本流程不用 `osascript` 驱动微信。本机实测该权限未授予，`System Events` 直接返回 `-10004`，所以路线是 CGEvent + AX API + 截图，而不是 AppleScript。

## 4. 显示器与坐标（跨设备最容易错的一处）

- **一律用 `ui shotregion` 打印的 `scale` 换算**：`全局点 = 区域原点 + 图片像素 / scale`。
  Retina 通常 2、外接 1x 屏是 1、缩放分辨率下可能是 1.5 —— **不要写死 2**。
- 多屏时窗口可能在副屏，全局坐标**可能为负**；`shotregion` 的 x/y 就是全局坐标，可以直接用。
- `ui shotwin`（`screencapture -l`）会把窗口阴影截进来，阴影宽度随窗口尺寸变化（实测 46～112 px），**只能看内容，不能用来算坐标**。
- 窗口位置在任何 raise / 激活后都会重排：**每次操作前重新取 `bounds`**，不要缓存。

## 5. 数据：不能照抄

- 发票抬头、统一社会信用代码、邮箱、订单笔数、金额 —— 全部因人而异。
- 文档与示例里**不放真实抬头/税号/单号**；执行时由用户提供并逐项确认。
- 提交是不可逆动作（平台明确「提交后不可修改」）：没有人工确认就停在提交前。

## 6. 两种拿法：源码包 vs 预编译包

| | 源码包（git clone / 仓库） | 预编译包（`scripts/package.sh` 产物） |
|---|---|---|
| 包里有 `scripts/ui` | 没有，要自己编 | **有** |
| 需要 Swift 工具链 | 需要（`xcode-select --install`） | **不需要**（同架构） |
| 首次命令 | `bash scripts/build.sh` → `ui doctor` | 直接 `ui doctor` |
| Intel（x86_64） | ✗ 不支持（`build.sh` 直接拒绝） | ✗ 不支持（`ui` 跑不起来，`ui doctor` 报 FAIL） |

打包方：`bash scripts/package.sh` → `dist/wechat-tencent-invoice-<version>-<arch>.tar.gz`，
脚本会自己解包验证一次，跑不过不出包。`dist/` 与 `ui` 均不入 git。

## 7. 首次使用三步

```bash
bash scripts/build.sh      # 1. 编译 ui（每台设备一次）
bash scripts/ui doctor     # 2. 自检：全 OK 才继续；有 FAIL 按提示修
# 3. 打开微信并登录，按 SKILL.md 的 control flow 走
```

`doctor` 的退出码：`0` 全通过 / `1` 有 FAIL（此时**不要硬点**，点了也不会生效）。

## 8. doctor 各项 FAIL 的含义

| FAIL 项 | 含义 | 修法 |
|---|---|---|
| swiftc | 没装 Command Line Tools | `xcode-select --install` |
| 辅助功能 | 点击会静默失效 | 授权给宿主程序后重启宿主 |
| 屏幕录制 | 截图拿不到内容 | 同上，勾屏幕录制 |
| 文字识别（Vision OCR） | 系统 OCR 不可用 | 走「模型看图」降级路径（SKILL.md 已写），或装 tesseract 作第二引擎 |
| 微信 | 没装/没运行 | 安装并登录 |
| 剪贴板 | pbcopy 往返失败 | 关掉剪贴板管理软件的拦截，或改用 `ui type` |

## 9. 已知不通过项（当前版本）

- **Vision OCR**：本机 macOS 27 上，**新编译**的二进制调 `VNRecognizeTextRequest` 报
  `TextRecognition.CRImageReaderError`（错误 9 / unknownError），而几小时前编译的旧二进制仍正常；
  根因未定位，与网络、图片大小、语言列表无关。
  → `doctor` 会报 FAIL；按 SKILL.md 的降级路径「模型看图」继续，不影响开票结果。
- **系统 OCR 首次可用性**：换设备时先跑 `doctor`，不要假设「我这台能用，别人那台也能用」。

## 10. 维护这份文件

改完界面流程、换了微信大版本、或 doctor 新增检查项时，**同步更新本文与 SKILL.md 的 `compatibility`**——
这两处是别人判断「能不能用」的唯一依据。
