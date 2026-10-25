---
name: wechat-tencent-invoice
description: 在微信 macOS 桌面版里申请腾讯充值发票（增值税普通发票）：搜索「腾讯充值」小程序 → 我的帐户 → 申请发票 → 勾选订单 → 填发票抬头与统一社会信用代码 → 提交 → 到开票记录核对。当用户说「去微信里开发票」「腾讯充值/Q币/微信读书订单要开票」「按我的电脑操作微信界面开票」时使用；要在能走 API / 商户后台时不要用，也绝不在没人确认抬头与金额时提交。
compatibility: "macOS + 中文版微信桌面版（实测 macOS 27.0.1 / 微信 4.1.13，已登录）；需要 Swift 编译器（Xcode Command Line Tools，用来编译 scripts/ui）；屏幕录制 + 辅助功能必须授权给「跑 Agent 的宿主程序」；建议宿主支持读图（系统 OCR 失效时的降级定位路径）。不需要 MCP/插件/Node/Python。当前只支持 Apple Silicon（arm64）。"
---

# 微信 · 腾讯充值开票

把「微信里给腾讯充值订单开发票」这件事做成可复现流程：**人确认抬头与金额，模型负责导航，脚本负责合成点击与 OCR 定位。**

> 语音/文字里的「开发票」多指这条：微信 → 腾讯充值小程序 → 我的帐户 → 申请发票。
> 与之无关的（DeepSeek 平台账单）见 Store 里的 deepseek-invoice 资产（procedure 与 orchestration 各一份）。

## 环境与适用范围

| | 内容 |
|---|---|
| **适用** | macOS（实测 27.0.1）+ **Apple Silicon（arm64）** + 中文版微信桌面版（实测 4.1.13，已登录）+ 宿主能执行 bash 命令、能读图（系统 OCR 失效时的降级定位靠它） |
| **不适用** | Intel / x86_64（`build.sh` 与 `ui doctor` 会直接拦下）；Windows / Linux；英文版微信；有 API / 商户后台可走的开票场景；没人确认抬头与金额就要求提交的场景 |
| **依赖** | `swiftc`（Xcode Command Line Tools）—— **只有源码包需要**；预编译包同架构解压即用。**不需要** MCP、插件、Node、Python、任何第三方包 |
| **权限**（授给「跑 Agent 的宿主程序」，不是授给脚本） | 辅助功能 = 合成点击/键盘；屏幕录制 = 截图；剪贴板 = 粘贴中文。**不需要** Apple Events（本流程不用 `osascript` 驱动微信） |
| **已知限制** | ① 系统 OCR（Vision）可能报 `CRImageReaderError`，此时降级为「模型看图」，见文末；② 微信改版/换语言会让锚点文字失效 —— 找不到就停，不许连点；③ 发票提交不可逆，必须人工确认 |

## 硬规则（违反即失败）

1. **提交前必须停下等人确认**：抬头、税号、金额、订单笔数逐项念出来，得到明确同意才点「提交」。发票提交后平台不允许修改。
2. **不写死坐标**。微信窗口每次 raise / 激活都会重排位置。每次操作前重新取 `bounds`，用 `-R` 区域截图并读它打印的 `scale`（Retina 2 / 外接 1x 是 1，别写死 2）现算，或用 OCR 返回的文字框定位。
3. **不猜页面**。每次点击后都要截图确认「观察点」出现了，再走下一步；页面没变就停下来，不要连点。
4. **只用普通发票**，除非用户明确要专用发票。客服页两条入口上下只差一行，很容易点错；专用发票要营业执照与开票声明。

## 0. 预检（换设备必做，本机也建议做）

```bash
bash scripts/build.sh     # 编译 ui（每台设备一次；缺 swiftc 会给出 xcode-select --install 提示）
bash scripts/ui doctor    # 逐项检查：swiftc / 辅助功能 / 屏幕录制 / 系统 OCR / 微信 / 剪贴板 / 显示器
```

- 退出码 `0` 全通过；`1` 表示有 FAIL —— **有 FAIL 不要硬点**（没授权时点击静默无效，点了也不会生效）。
- 系统 OCR FAIL 不阻断流程：按下面「如果 `ui ocr` 报错」走「模型看图」降级。
- 每项 FAIL 的修法原文写在 `doctor` 输出里，跨设备完整清单见 [references/portability.md](references/portability.md)。

## Control flow

1. **PREFLIGHT** — `scripts/ui windows wechat` 列出微信窗口；确认 `WeChat` 进程存在、有名为「腾讯充值」（或主窗口 `Weixin`）的窗口。截一张窗口图确认能看到内容（黑图 = 缺屏幕录制权限）。
2. **OPEN** — 微信主窗口搜索框输入「腾讯充值」→ 回车。观察点：出现名为 `腾讯充值` 的独立窗口。
3. **ACCOUNT** — 点小程序底部「我的帐户」。观察点：弹出「我的余额 / 充值记录 / 续费管理 / 积分兑换 / 申请发票」。
4. **INVOICE ENTRY** — 点「申请发票」。观察点：微信内置浏览器打开《如何申请发票？ - 腾讯客服》。
5. **GENERAL** — 点第一行「开具增值税普通发票，请点击（申请入口）」。观察点：跳到微信授权页（头像 + 「申请发票」/「开票记录」两个按钮）。
   若进了《开具增值税专用发票须知》= 点到了第二行，浏览器后退重来。
6. **SELECT** — 点「申请发票」→ 勾选订单。观察点：底部「总价：¥xx.00」随勾选累加，「下一步」由灰变蓝。
7. **FORM** — 「下一步」→ 抬头类型选「组织」（事业单位/高校一般选组织）→ 观察点：出现 发票主体 / 发票项目 / 发票金额 只写入，以及两个输入框。
8. **FILL** — 填 `*发票抬头名称` 与 `统一社会信用代码`。**必须点中占位符文字本身**（偏上约 20 点就不聚焦），再用 `ui paste` 粘贴中文。
9. **CONFIRM —【停下来等人批准】**：把 订单笔数 / 金额合计 / 发票类型 / 抬头 / 税号 五项摆给用户，等明确「确认提交」。
10. **SUBMIT** — 点「提交」→ 弹窗「发票申请提交后不可修改」→ 点「确认」。观察点：出现「申请成功 / 您提交的开票申请已受理」。
11. **VERIFY** — 返回首页 →「开票记录」。观察点：列表第一行是新单，金额/状态（「开票中」）/开票单号齐备。把单号报给用户。
12. **CLEANUP** — 关掉内置浏览器窗口，恢复被最小化的宿主窗口。

## Routing

- 完整 12 步的观察点、踩坑实录、何时别用 → [references/flow.md](references/flow.md)
- 跨设备清单（依赖 / 权限 / 显示器缩放 / 版本与语言 / 首次三步）→ [references/portability.md](references/portability.md)
- 界面档案（三个窗口、AX 读不到内容、applescript 是死路）→ Store 里的 computer-automation 界面档案：重构前在 `computer-automation/computer-use/wechat-macos/`，重构后在 `orchestrations/computer-automation/wechat-tencent-invoice/README.md`
- 合成点击 / OCR / 窗口定位脚本 → `scripts/ui.swift`（`scripts/build.sh` 编译一次）

## Scripts

| 命令 | 用途 |
|---|---|
| `bash scripts/package.sh` | 打可分发包（含预编译 `ui`），产物在 `dist/`，不入 git |
| `ui doctor` | **环境自检**：swiftc / 辅助功能 / 屏幕录制 / 系统 OCR / 微信 / 剪贴板 / 显示器；退出码 0 全通、1 有 FAIL |
| `ui windows wechat` | 列窗口：id / owner / name / bounds / layer / onscreen |
| `ui shotregion x y w h out.png` | 区域截图，并打印 `scale=`（Retina 2、外接 1x 屏 1）——换算一律用它，不要写死 2 |
| `ui shotwin <winid> out.png` | 单窗口截图（遮挡也能读，用于看内容，**不要用来算点击坐标**） |
| `ui ocr out.png` | Vision OCR：`x,y,w,h<TAB>文字`（像素坐标） |
| `ui click x y` / `ui click2 x y` | 合成点击；`click2` 带 mouseMoved + clickState，网页按钮更稳 |
| `ui paste <text>` / `ui type <text>` | 粘贴（中文走这条）/ 逐字键入 |
| `ui key <code> [cmd,shift,alt,ctrl]` | 组合键（⌘V=9，⌘A=0，回车=36，Tab=48） |
| `ui focuswin <pid> <标题片段>` | AX 置 main/focused + raise——**键盘与点击前先做这步** |
| `ui setwin <pid> <标题片段> x y w h` | 固定窗口位置（宿主窗口挡路时把目标挪出来） |
| `ui minwin <pid>` / `ui activate <app>` | 最小化 / 激活（激活会把该 app 主窗口抬到最前，慎用） |

## 分发（把这个 skill 打包给别人）

```bash
bash scripts/package.sh                 # 产物：dist/wechat-tencent-invoice-<version>-<arch>.tar.gz
```

- 包内**带编译好的 `scripts/ui`**，接收方解压即用（同架构时**不需要** Swift 工具链）。
- `package.sh` 会自证：解到临时目录、跑一次 `ui status`，跑不过就不出包。
- **只支持 Apple Silicon（arm64）**：Intel 机器不在支持范围（`build.sh` 与 `ui doctor` 都会直接拦下）。
  产物名带架构后缀，是为了拿到 Intel 机器上时能一眼看出不匹配，而不是暗示"两边都支持"。
- `dist/` 与 `ui` 都在 `.gitignore` 里：**产物只进发布包，不进 git。**

## 失败即停的条件

- `ui ocr` 找不到「申请入口」「我的帐户」「提交」等锚点文字；
- 点击后页面没变化（连续两次）；
- 出现「专用发票须知」而用户要的是普通发票；
- 金额合计与用户预期不符。

## 如果 `ui ocr` 报错（CRImageReaderError）

本机实测：同一天里 Vision 文字识别对新编译的二进制会报 `TextRecognition.CRImageReaderError`（旧二进制仍正常），原因未查明。**这不该阻断流程**，降级为：

1. `ui shotregion <x> <y> <w> <h> /tmp/r.png` 截区域（坐标映射无偏移，像素/2 = 点数）；
2. 由**会看图的模型**直接读这张图，指出目标文字在图片里的位置；
3. 换回全局坐标点击：`全局点 = 区域原点 + 图片像素/2`。

`ui shotwin` 也可以让人看内容，但**不能用来算坐标**（窗口阴影宽度随尺寸变）。

