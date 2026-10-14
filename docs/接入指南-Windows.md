# 接入指南 · Windows

> 给使用者的四步。装完就能用——不需要飞书开发者账号、不需要授权任何应用、
> 不需要填模型 key。
>
> **命令在哪跑**：下面的命令都能在 **PowerShell** 或 **命令提示符（cmd）** 里跑。
> 遇到"禁止运行脚本"的报错就改用 **cmd**（见「常见问题」）。

---

## ① 安装

```powershell
npm install -g teaming-mcp
```

**Windows 上一般不会遇到权限问题** —— npm 的全局目录默认在
`%APPDATA%\npm`（你自己的用户目录下），本身就是可写的。

**验证装好了：**

```powershell
teaming --version        # 应输出 0.1.0
```

**如果提示 `teaming 不是内部或外部命令`** → `%APPDATA%\npm` 不在 PATH 里：

```powershell
# 看一下当前 PATH 里有没有它
$env:PATH -split ';' | Select-String 'npm'
```

**没有就加上**（用户级，不需要管理员）：

```powershell
[Environment]::SetEnvironmentVariable(
  "PATH",
  [Environment]::GetEnvironmentVariable("PATH","User") + ";$env:APPDATA\npm",
  "User"
)
```

**然后关掉终端重开一个。**

---

## ② 用接入码配好

```powershell
teaming setup --code ABC12345
```

把 `ABC12345` 换成管理员给你的 8 位码（不含 `0/O`、`1/I/L`）。

**成功会输出：**

```
✅ 配置已写入 C:\Users\你\.teaming-mcp\config.json
   归属集成：……
   模型端点：https://api.deepseek.com/v1
   分析模型：deepseek-flash
```

**这一步配好了三件事**：你的专属服务器凭证、报告接收地址、模型配置。
全部写进 `C:\Users\你\.teaming-mcp\config.json`。

---

## ③ 在豆包工作里加连接器

**豆包工作 → 连接器 → 新建自定义连接器**

**先跑这两条，拿到你机器上的真实路径：**

```powershell
(Get-Command node).Source      # 或：where.exe node
npm root -g
```

**典型的输出：**

```
(Get-Command node).Source  →  C:\Program Files\nodejs\node.exe
npm root -g                →  C:\Users\你\AppData\Roaming\npm\node_modules
```

**然后按下面填：**

| 字段 | 填什么 |
|---|---|
| 服务器名称 | `teaming` |
| 传输类型 | `STDIO` |
| 命令 | node 的完整路径，例如 `C:\Program Files\nodejs\node.exe` |
| 参数 | `npm root -g` 的输出 + `\teaming-mcp\src\mcpServer.mjs` |
| 环境变量 | **不填** |

**参数的实际样子：**

```
C:\Users\你\AppData\Roaming\npm\node_modules\teaming-mcp\src\mcpServer.mjs
```

**⚠️ 填之前先确认路径真的存在：**

```powershell
Test-Path "C:\Users\你\AppData\Roaming\npm\node_modules\teaming-mcp\src\mcpServer.mjs"
```

**返回 `True` 才对。** 返回 `False` 就回到第①步检查安装。

> **如果用的是 WorkBuddy**：编辑 `%USERPROFILE%\.workbuddy\mcp.json`，
> 加同样一段配置，然后**在界面上手动信任一次**——只写文件不生效。
>
> **⚠️ JSON 里路径的反斜杠要写两个：**
> ```json
> {
>   "command": "C:\\Program Files\\nodejs\\node.exe",
>   "args": ["C:\\Users\\你\\AppData\\Roaming\\npm\\node_modules\\teaming-mcp\\src\\mcpServer.mjs"]
> }
> ```
> 这是 JSON 的转义规则，漏了会解析失败。

**填完保存。**

---

## ④ 验证

**在豆包工作里对它说：**

> 跑一下 teaming_doctor

**应该看到：**

```
OK    lark-cli 可用
SKIP  飞书已授权        新架构下由宿主取数，MCP 不需要飞书授权
SKIP  会议搜索权限      同上
SKIP  妙记读取权限      同上
OK    分析引擎已构建
OK    分析凭证可用
OK    模型端点
OK    分析模型

可以开始使用。3 项已跳过（当前架构下不需要）。
```

> **3 项 SKIP 是正常的。** 逐字稿由豆包工作自己取，MCP 不接触飞书——
> 所以它不需要飞书授权。这跟"出错"是两回事。

---

## 用起来

**手动分析：**

> 分析一下我昨天那个会

**自动分析**：在豆包工作里建一个定时任务，提示词见下方「定时任务」。

---

## 数据放在哪

| 数据 | 位置 |
|---|---|
| 配置（含你的凭证） | `C:\Users\你\.teaming-mcp\config.json` |
| 报告与逐字稿 | `C:\Users\你\.teaming-mcp\.out\` |
| 任务记录 | `C:\Users\你\.teaming-mcp\.state\` |

---

## 常见问题

### 跑 `npm` 报「因为在此系统上禁止运行脚本」

PowerShell 的执行策略挡住了 `npm.ps1`。**最简单的办法是改用 cmd**（开始菜单搜 `cmd`）。

**或者放行当前用户：**

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### 报"模型返回为空"？

DeepSeek 官方说明 JSON 模式下**有概率返回空内容**。引擎会自动重试与局部修复，
偶尔仍可能失败。**这与你的逐字稿无关**，重跑一次通常就好。

### 换了模型之后结论不一样？

**正常。** 引擎提示词是针对特定模型调的；同一份逐字稿在不同模型下，
Zone 判定可能不同——甚至同一模型跑两次边界也会跳动。这是已知现象。

### 报告说"逐字稿不合格"？

**分析只认成员原始发言**（每行形如「姓名 MM:SS 发言内容」）。
AI 摘要、会议纪要、待办列表都不算，会被明确拒绝——这是有意的，
拿摘要去分析会得出假结论。

### 重装/换电脑会重复分析吗？

不会。**同一份逐字稿按内容哈希复用已有报告**，不重复消耗额度。

### 路径里有空格（`C:\Program Files\...`）怎么办？

**在连接器的输入框里直接填，不用加引号。** 如果是在 `.json` 配置文件里写，
反斜杠要写两个（`C:\\Program Files\\...`）。

---

## 卸载

```powershell
npm uninstall -g teaming-mcp
Remove-Item -Recurse -Force "$env:USERPROFILE\.teaming-mcp"
```

**别忘了**：让管理员吊销你的宿主凭证（服务端只存了它的哈希，可单独吊销）。

---

## 定时任务提示词

在豆包工作里新建定时任务，粘贴这段：

> **⚠️ 与 Mac 版的差别**：`--output-dir` 从 `/tmp` 改成了 `%TEMP%`，
> 因为 Windows 上没有 `/tmp`。

```
监控我在飞书会议中产生的妙记，发现新妙记就取逐字稿做团队动力分析并汇报。

执行步骤：
1) 用 lark-cli minutes +search 分别按 --owner-ids me 与 --participant-ids me
   查询最近 2 小时生成的妙记，按 token 去重合并；
   与上次已汇报过的 minute_token 比对，只处理新出现的。

2) 对每个新妙记，取逐字稿：
   lark-cli minutes +detail --minute-tokens <token> --transcript ^
     --output-dir %TEMP% --as user --format json
   ⚠️ flag 是 --minute-tokens（复数）；必须显式传 --transcript；
      --output-dir 用 Windows 的临时目录 %TEMP%
   读取返回的 data.minutes[0].artifacts.transcript_file 文件内容。
   拿不到逐字稿就如实说明，不要用 AI 摘要替代。

3) 调用 MCP 工具 teaming_analyze_transcript，传：
   transcript = 上一步读到的逐字稿原文
   title      = 妙记标题
   它会立刻返回 status=running 和 job_id（不要重复调用）。

4) 用 teaming_job_status 轮询同一个 job_id 直到 status=done
   （约半分钟，每 15~30 秒查一次）。

5) 汇报：团队状态定位、互动概览、未完成的对话与非共识、给领导者的建议，
   以及返回里的 reportUrl（带图表的网页报告页）。

约束：查询为空就如实说明原因，不要编造；同一份逐字稿重复分析会复用已有报告。
```

**频率建议**：工作日 08:00–23:00，每小时一次。
