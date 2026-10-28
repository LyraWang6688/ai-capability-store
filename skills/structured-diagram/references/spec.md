# 结构图解 JSON 规格

独立生成器的 JSON 契约，沿用旧 layered / flow 字段。生成器运行前校验未知字段、类型、数量和文案长度，失败则不生成文件。

## 顶层

| 字段 | 类型 | 必填 | 限制 |
|---|---|---|---|
| `type` | `"layered"` \| `"flow"` | ✅ | 决定用哪个模板 |
| `title` | string | — | ≤ 24 字符 |

## `layered` — 分层结构

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `top` | node | — | 顶部胶囊（任务 / 输入） |
| `group` | object | ✅ | 中间的分组容器 |
| `bottom` | node | — | 底部胶囊（产出 / 结果） |

```jsonc
node   = { "icon"?: icon, "title": string, "sub"?: string }
group  = { "icon"?: icon, "title": string, "label"?: string, "cards": card[] }
card   = { "icon"?: icon, "en"?: string, "cn"?: string }   // en / cn 至少一个
```

- `cards` 数量 **2~6**。超过 6 会挤，建议拆图或改表格。
- `group.label` 是层名（例如「Harness 运行与控制层」），显示在卡片网格上方。

## `flow` — 有顺序 / 有回环的过程

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `start` | string | — | 起点胶囊 |
| `steps` | step[] | ✅ | **2~8** 步 |
| `loopback` | string | — | 回环说明，显示在步骤框底部 |
| `end` | string | — | 终点胶囊（绿色） |

```jsonc
step = { "n"?: number, "title": string, "desc"?: string }
```

- `n` 省略时按数组顺序自动编号 1..N。
- 每一步之间会自动画向下箭头，不需要自己写。

## 文案长度上限

超限时生成器拒绝输出，先缩短文案。

| 位置 | 上限（字符） |
|---|---|
| `title` | 24 |
| `node.title` | 12 |
| `node.sub` | 18 |
| `group.title` | 16 |
| `group.label` | 14 |
| `card.en` | 14 |
| `card.cn` | 10 |
| `step.title` | 22 |
| `step.desc` | 18 |
| `start` / `end` / `loopback` | 24 |

> 中英混排按字符数算，不是按字节。

## 图标

只允许这 10 个：

| 名字 | 语义 |
|---|---|
| `user` | 人 / 任务 / 输入方 |
| `brain` | 模型 / 推理 / 智能层 |
| `book` | 知识 / 上下文 / 记忆 |
| `tools` | 工具 / 执行 / 环境 |
| `loop` | 循环 / 重试 / 编排 |
| `shield` | 权限 / 安全 / 边界 |
| `clipboard` | 校验 / 记录 / 评测 |
| `database` | 存储 / 状态 / 持久化 |
| `check` | 结果 / 完成 |
| `arrow` | 连接（模板自带，一般不手写） |

写错名字 → 图标**静默消失**，卡片只剩文字。校验脚本会拦。

## 使用方式

将 JSON 保存为文件，交给 `scripts/render_diagram.py`，不要输出宿主专属围栏。未知字段、错误类型或超限文案会被拒绝；先缩短文字，再生成图片。

## 完整示例

### layered

```json
{
  "type": "layered",
  "title": "Agent Harness 简化架构",
  "top": { "icon": "user", "title": "用户任务", "sub": "目标、约束、验收标准" },
  "group": {
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

### flow

```json
{
  "type": "flow",
  "title": "Agent Loop：一次任务中的持续执行",
  "start": "接收任务",
  "steps": [
    { "n": 1, "title": "Observe · 观察",         "desc": "读取文件、页面、工具反馈" },
    { "n": 2, "title": "Think / Decide · 决策",  "desc": "判断下一步应该做什么" },
    { "n": 3, "title": "Act · 行动",             "desc": "调用工具或修改环境" },
    { "n": 4, "title": "Evaluate · 检查",         "desc": "验证是否达到目标" }
  ],
  "loopback": "未通过 → 利用反馈继续循环",
  "end": "完成并通过验收 → 停止"
}
```

