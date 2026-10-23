# diagram-card · 对话内架构图卡片

把回复里的 ` ```dsh-diagram ` 代码块，**渲染成结构化卡片图**，而不是让读者看一段 JSON。

```text
你说：帮我画一下 Agent Harness 的架构

我回复：
  ┌─────────────────────────────┐
  │  Agent Harness 简化架构      │   ← 卡片图（本插件渲染）
  │  用户任务 → LLM+Harness 六能力 → 结果 │
  └─────────────────────────────┘

  代码块本身仍在消息里（隐藏），是唯一事实源。
```

- **纯客户端**：无 Host 路由、无子进程、无网络请求、无凭据。
- **不生成图片**：渲染的是真实 DOM，文字可选中、可复制、可搜索，缩放不糊。
- **JSON 是事实源**：插件只负责“上色”，删掉插件消息仍可读（退回代码块）。

## 安装

**方式一（推荐）：DSH 插件页按包名安装**

设置 → 插件 → 安装 bundle，输入包名：

```text
@lyra_wang/dsh-diagram-card
```

装完**重启 DSH** 生效。

**方式二：命令行**

```bash
# 1) 从 npm 安装
dsh plugin --profile desktop add "https://registry.npmjs.org/@lyra_wang/dsh-diagram-card/-/dsh-diagram-card-0.1.0.tgz"

# 2) 把包名加入 profile 的 dsh.profile.bundles（否则装了不挂载）
#    ~/.dsh/profiles/desktop/package.json
#    "dsh": { "profile": { "bundles": [ ..., "@lyra_wang/dsh-diagram-card" ] } }
```

**3) 重启 DSH 生效。**

> ⚠️ 刚 `npm publish` 后 registry 有几分钟 staging 窗口，此时安装会 404，等一下再试。
>
> 开发期可用本地路径安装，但按 `AGENTS.md`「Local Consumption」规则，
> 交付前必须改为 npm 安装，不允许长期运行仓库内路径。

## 用法

在回复里输出一个 `dsh-diagram` 代码块，内容是 JSON。

### 类型一：`layered`（分层架构）

````text
```dsh-diagram
{
  "type": "layered",
  "title": "Agent Harness 简化架构",
  "top":    { "icon": "user",  "title": "用户任务", "sub": "目标、约束、验收标准" },
  "group":  {
    "icon": "brain",
    "title": "大语言模型（LLM）",
    "label": "Harness 运行与控制层",
    "cards": [
      { "icon": "book",      "en": "Context",    "cn": "上下文与记忆" },
      { "icon": "tools",     "en": "Tools",      "cn": "工具与执行环境" },
      { "icon": "loop",      "en": "Loop",       "cn": "循环与任务编排" },
      { "icon": "shield",    "en": "Guardrails", "cn": "权限与安全边界" },
      { "icon": "clipboard", "en": "Evaluation", "cn": "测试与结果验证" },
      { "icon": "database",  "en": "State",      "cn": "状态与进度持久化" }
    ]
  },
  "bottom": { "icon": "check", "title": "可验证的任务结果", "sub": "代码、报告、数据或业务动作" }
}
```
````

### 类型二：`flow`（流程 / 循环）

````text
```dsh-diagram
{
  "type": "flow",
  "title": "Agent Loop：一次任务中的持续执行",
  "start": "接收任务",
  "steps": [
    { "n": 1, "title": "Observe · 观察",      "desc": "读取文件、页面、工具反馈" },
    { "n": 2, "title": "Think / Decide · 决策", "desc": "判断下一步应该做什么" },
    { "n": 3, "title": "Act · 行动",          "desc": "调用工具或修改环境" },
    { "n": 4, "title": "Evaluate · 检查",      "desc": "验证是否达到目标" }
  ],
  "loopback": "未通过 → 利用反馈继续循环",
  "end": "完成并通过验收 → 停止"
}
```
````

### 图标名

`user` · `brain` · `book` · `tools` · `loop` · `shield` · `clipboard` · `database` · `check` · `arrow`

（24×24 viewBox 线性图标；未识别的名字会静默省略，不报错。）

## 设计参数（来自实测的参考图）

| 变量 | 深色 | 用途 |
|---|---|---|
| `--ddg-panel` | `#0E0E0E` | 任务 / 结果胶囊 |
| `--ddg-card` | `#303030` | 能力卡片 |
| `--ddg-num` | `#212121` | 步骤编号圆 |
| `--ddg-line` | `rgba(255,255,255,.15)` | 画布描边 |
| `--ddg-text` / `--ddg-text2` / `--ddg-text3` | `#EDEDED` / `#CDCDCD` / `#AFAFAF` | 三级文字 |
| `--ddg-info` | `#2C67C5` | LLM / 回环 |
| `--ddg-success` | `#40C977` | 完成态 |

尺寸：画布 `max-width:792px` / 圆角 `16px` / 内距 `12px`；卡片圆角 `8px`；胶囊圆角 `12px`；
标题 `14/20 500`；卡片英文 `12/16 500`、中文 `14/18`。

浅色主题自动适配：渲染时读取宿主 `body` 背景亮度，亮度高于阈值即启用 `.dshdg-light` 变量组。

## 布局与自适应

卡片没有固定高度 —— 高多少由内容撑开。随宿主变化的是**密度**，不是高度：

| 维度 | 规则 | 实测 |
|---|---|---|
| 字号 / 内距 | `clamp()` 跟随视口宽度，正文 13–16px | 1280 宽 → 15.1px；1600 宽 → 16px；452 宽 → 13px |
| 列数 | `>480px` 两列；`≤480px` 单列 | 六卡在两列下 3 行 |
| 宽度 | 默认 `min(900px, 100%)`；视口 `≥1100px` 放宽到 980px | 受消息气泡宽度约束，不会溢出 |
| 窗口高度 | `@media (max-height:760px)` 自动紧一档（内距与行高） | 矮窗口让出高度，不强制滚动 |

分层图实测高度：1280×802 → **546px**；1600×1000 → **644px**；约 450 宽 → **483px**。

**边界**：信息量固定，屏幕变小只有三种出路 —— 滚动、缩小、截断。本项目选**滚动**，
不做整体缩放（`transform:scale` 会把 15px 压到 10px，得不偿失）。

## 边界与已知限制（如实）

| 项 | 状态 | 说明 |
|---|---|---|
| 槽位 | ✅ `shell.overlay` | 只用了已验证稳定的槽位。**为什么不挂消息插槽**：已读源码确认 `conversation.chat.node` 是 keyed slot（按节点类型整体替换），assistant 正文是固定组件、只有 reasoning / images 两个子槽——"消息内插内容"这条路当前版本不通。见 [`../README.md` §3.4](../README.md) |
| 渲染方式 | ⚠️ DOM 观察 | **不是临时方案**：源码确认没有更合适的插槽，这是当前版本唯一可行路径。插件监听 `pre > code` 代码块并就地替换，宿主若改消息 DOM 结构需要同步调整 |
| 流式输出 | ✅ 渐进 | JSON 不完整时 `JSON.parse` 失败 → 保持代码块原样；解析成功后才替换 |
| 重复渲染 | ✅ 幂等 | 按内容 hash 去重；宿主重绘后自动补渲染 |
| 宿主重绘 | ✅ 自愈 | `MutationObserver` + 2s 轮询兜底，卡片被移除会重新插入 |
| 超长内容 | ⚠️ 未测试 | 单块超过 ~20KB 未做压力验证 |
| 图片导出 | ❌ 不支持 | 需要图片请用同一套 token 单独导出（见 `visual-assets/`） |

**没有做的事**（避免过度承诺）：不支持任意 HTML/CSS 注入、不支持交互（折叠/点击）、
不写入任何存储、不修改消息内容本身。

## 安全

- 无 `fetch` / 无 WebSocket / 无子进程 / 无文件系统访问。
- 用户文本一律 `textContent` 写入；唯一的 `innerHTML` 是**本文件内的静态图标表**（编译期常量）。
- 不读取其它插件的 DOM 或样式；不改 `document.body`；样式只注入自己的 `<style>`。

## 排错

| 现象 | 排查 |
|---|---|
| 代码块没变成卡片 | DevTools Console 看是否 `@lyra_wang/dsh-diagram-card` 已加载；确认 JSON 合法 |
| 整个 App 起不来 | 检查 `package.json` 的 `dsh.client.inject` 是否只包含已安装包（本插件只声明 `@deepseek-ai/dsh-client-ui-layout`，与既有插件一致）|
| 卡片闪一下就消失 | 宿主重绘；观察 2s 内是否自动恢复，未恢复请记录 DOM 结构 |
| 深浅色不跟随 | 宿主主题检测依赖 `body` 背景亮度，若为空会退回 `data-theme` 属性 |

## 与 Store 的关系

- 实例根：`external-capabilities/plugin/dsh/diagram-card/`
- Registry：`external-capabilities/registry.yaml` → `diagram-card`
- 版本只在 registry 记（见 `VERSIONING.md` §1），`package.json` 与之保持一致。
