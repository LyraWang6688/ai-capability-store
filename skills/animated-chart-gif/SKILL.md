---
name: animated-chart-gif
description: 生成公众号正文用的 720×540 动图（柱状图 / 折线图 / 流程图三种模板），12.5fps、暖白底、体积可控。当用户要给公众号文章加数据动图、前后对比图、趋势/权衡曲线、或流程链路示意动图，或说「把这个数据做成动图」「文章配个动图」「做成 GIF」时使用。不用于视频剪辑、多轴/可交互图表、非 GIF 输出，也不替代公众号正文排版（那走 wechat-html-css-layout）。
compatibility: 需要 Python 3 与 Pillow；需要 macOS 中文字体（Hiragino Sans GB 或 STHeiti Light）；纯本地运行，无需网络、无需 MCP。
---

# WeChat GIF Chart

把一组数据或一条流程渲染成**可直接插进公众号正文的动图**。

## 规格（这不是随便定的）

| 项 | 值 | 为什么 |
|---|---|---|
| 尺寸 | **720×540（4:3）** | 公众号正文宽度约 677px，此尺寸几乎不被二次压缩 |
| 帧率 | **12.5 fps（每帧 80ms）** | 体积可控；30fps 会让文件翻倍且肉眼看不出差别 |
| 底色 | `rgb(249,248,245)` | 暖白纸感，与常见公众号排版协调 |
| 格式 | GIF89a，`loop=0` | 微信端自动循环播放 |
| 体积目标 | **≤ 400KB** | 同尺寸实测区间 130–350KB 加载无感 |

## 三种模板

| type | 用途 | 长什么样 |
|---|---|---|
| `bar` | 前后对比、成本差距、数量级差异 | 横向轨道条逐条填充，数值同步跳动，末尾出结论句 |
| `line` | 趋势、拐点、权衡曲线 | 曲线逐段生长，红色游标沿曲线移动，右上角读数随动 |
| `flow` | 链路、步骤、架构 | 方块依次高亮，底部逐条出说明 |

## 怎么用

```bash
python3 scripts/render_gif.py <spec.json> <out.gif>
```

`spec.json` 用一个 `type` 字段选模板，其余字段按模板填。示例在 `assets/examples/`：

```bash
python3 scripts/render_gif.py assets/examples/bar.json out/bar.gif
```

### `bar` 的最小 spec

```json
{
  "type": "bar",
  "title": "短期记忆丢了，要重算多少",
  "subtitle": "读题时，有 20 层要重建最近的短期记忆",
  "conclusion": "整个读题阶段的计算量，少了将近一半",
  "footer": "数据：<来源>",
  "rows": [
    { "label": "原来：重算最后 2560 个 token", "max_value": 2560, "from_value": 0, "to_value": 2560, "unit": " token" },
    { "label": "新法：重算最后 128 个",        "max_value": 2560, "from_value": 0, "to_value": 128,  "unit": " token" }
  ]
}
```

### `line` 的最小 spec

```json
{
  "type": "line",
  "title": "每个人越快，总产出越少",
  "x_label": "每个人的速度",
  "y_label": "单卡每秒总产出",
  "points": [[30, 32000], [80, 29000], [140, 24000], [200, 17000], [250, 9000], [300, 3200]],
  "readouts": [
    { "at": 0, "value": 8,   "text": "当前并发 {v}", "note": "单人很快，但总产出见顶" },
    { "at": 3, "value": 128, "text": "当前并发 {v}", "note": "并发上来，总产出开始掉" }
  ]
}
```

### `flow` 的最小 spec

```json
{
  "type": "flow",
  "title": "一个请求，在系统里怎么走",
  "steps": [
    { "label": "接入", "note": "拿请求" },
    { "label": "解析", "note": "转 token" },
    { "label": "读题", "note": "Prefill" },
    { "label": "答题", "note": "Decode" }
  ],
  "notes": ["第一步：请求进来，先落到接入层。", "第二步：文本被切成 token。"],
  "footer": "示意：仅用于演示版式"
}
```

## 写作纪律（重要）

- **不要编数据。** 动图里每个数字都要能指回来源；`footer` 必须写清来源或写「示例数据」。
- **一图一个结论。** `conclusion` 只放一句话；要讲三件事就做三张图。
- **对比要同口径。** `bar` 的多行用同一个 `max_value`，否则视觉比例会说谎。
- **`line` 的 `readouts` 至少 2 条**，否则没有动画。
- 缺量化结果时**不画图**，用文字讲清事实，不要用动图制造数字感。

## 坑位

- Pillow **打不开 `PingFang.ttc`**（新版 TTC 格式）→ 用 `Hiragino Sans GB.ttc`，脚本已按优先级自动选。
- `optimize=True` 会把**连续相同帧合并并累加时长**。这是好事（文件更小、播放不变），但别用「帧数 × 80ms」反推时长——要读 GIF 的 GCE 块。
- 逐帧直出 GIF（而非先录视频再转码）不会引入 8×8 块效应，文字边缘更干净。
- 体积超 400KB 时：减少动画帧数、缩短 `hold`、或合并同色区域。

细节与实测依据见 [references/spec.md](references/spec.md)。
