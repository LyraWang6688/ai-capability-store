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

## 布局与适配（0.1.3）

卡片是消息流里的一项，**高度没有固定画布**；0.1.3 起不再"由内容无限撑开"，而是按
**可见区预算**分三档降级。只有滚动容器、卡片宽度、内容尺寸变化时才重新适配，用户滚动不触发。

| 档位 | 何时 | 做什么 |
|---|---|---|
| 普通 | 自然高度 ≤ 预算 | 原始布局 |
| 紧凑 | 超预算 | 只动四个杠杆：外层 padding/gap、卡片 padding/gap、中文摘要最多两行、宽度够时网格加到三列；**不缩字号** |
| 滚动 | 紧凑后仍超预算 | 压到预算高度，正文区内部滚动，并给「展开查看 / 收起」按钮 |

预算的算法（不猜挡住的元素）：

```js
visible = intersection(scroller.getBoundingClientRect(), viewport) 的高度
budget  = floor(min(visible * 0.8, visible - 24))   // 80% 是给输入框/顶栏留的余量
```

- 滚动容器：从卡片父级往上找最近的 `overflow-y:auto|scroll` 且 `clientHeight > 0` 的祖先；
  找不到就退回文档视口。**不用 `scrollHeight > clientHeight` 当必要条件**（内容没撑满会误判）。
- 卡片的 `offsetTop` **不参与预算**：它只决定用户有没有滚到这张卡，不决定卡片能做多高。
- 观察 `ResizeObserver`（卡片 + 滚动容器）与 `document.fonts.ready`，事件合并到 rAF；
  同一组宽高只评估一次，避免测量循环。
- 宿主 markdown 的 `p` / `hr` 外边距会穿透进卡片（实测每段多 32px），因此样式表里有
  `margin:0!important` 的宿主隔离层。

**边界**：对任意滚动位置都"整卡可见"不可能（可能只滚出一小截）。承诺的是"滚到合适位置时整卡在可见区里完整"；
极窄/极矮窗口里连卡片外壳都放不下时，退化为内部滚动 + 展开入口。

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

**没有做的事**（避免过度承诺）：不支持任意 HTML/CSS 注入、不写入任何存储、不修改消息内容本身。
唯一的交互是超预算时的「展开查看 / 收起」按钮（0.1.3 起）。

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
