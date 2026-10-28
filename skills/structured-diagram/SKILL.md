---
name: structured-diagram
description: 将组成、归属、分层架构和流程概览制作成结构图解，输出 PNG、SVG 或独立 HTML。当图比文字更能帮助读者同时对照各部分、理解层级或步骤关系时，主动按需使用，无需用户明确要求画图。不限定 DSH，不需要插件。不用于数值趋势、占比、复杂网络或动态过程演示；动态变化使用 animated-chart-gif。
compatibility: HTML/SVG 生成与 JSON 校验仅需 Python 3 标准库；PNG 另需 Pillow 和支持中文的字体（可用 --font 指定）。无需浏览器、DSH、插件、网络或 MCP。
---

# 结构图解

用完整、稳定的画面帮助读者同时理解各部分；动态过程交给 `animated-chart-gif`。原名 `dsh-diagram`，现在是独立 Skill，默认允许 agent 按需选择。

## 什么时候画

当分层或流程模板能明显减少读者来回对照、记忆和推断时使用；不机械要求满足多项条件。简单问题、一两句话足够的回答、纯列表或用户只要文字时，继续用文字。

- `layered`：任务/输入 → 分组与并列模块 → 结果，表达组成与归属。
- `flow`：起点 → 有序步骤 → 回环说明 → 终点，表达流程概览；不假装具有播放能力。
- 复杂因果、多对多网络、泳道、并行分支不能硬套线性模板；改用合适的图形能力或文字。不要编造关系、因果或先后顺序。
- 默认一张图；过多内容优先合并概念。用户要求多图或确需独立对照时可用多张，不把整篇正文搬进卡片。

## 制作与交付

1. 读取 [字段规格](references/spec.md)，按真实内容生成 JSON；保留原 `layered` / `flow` 字段兼容。
2. 运行内置生成器（自动校验）：

```bash
python3 scripts/render_diagram.py assets/examples/layered.json /tmp/harness.png
python3 scripts/render_diagram.py assets/examples/flow.json /tmp/loop.html
python3 scripts/render_diagram.py assets/examples/layered.json /tmp/harness.svg --theme dark
```

以上相对路径均以本 Skill 目录为基准；在其它工作目录调用时使用绝对路径。流程图固定浅色，显式传入 dark 也按浅色生成，HTML 不跟随系统变暗。分层图 PNG 默认浅色、HTML 默认随系统主题，也可指定 `--theme light|dark`；`--width 390` 生成适合手机阅读的单列布局。PNG 可用 `--scale 2` 提高清晰度。

3. 优先 PNG 并在支持图片的回复中直接展示；需要可选文字或随系统主题时用独立 HTML；需要矢量编辑时用 SVG。不输出宿主专属代码围栏，不让用户安装配套插件。
4. 查看生成图，检查中文、长文、连线、边界与空白。缩小后难读时改布局，不无限缩字号。HTML 无播放或展开控件，内容全部展示，窄屏由容器横向滚动；面向手机优先重新以 390px 生成。
5. 用简短正文解释图中最重要的关系；生成成功与实际查看分别报告。仅提供宿主支持的显示或预览，不承诺所有聊天都能内嵌 HTML。

## 视觉与约束

详见 [视觉规范](references/visual-style.md)。白底、浅蓝分区、深灰文字、浅灰起点、绿色结果；统一圆角、线性图标与间距。布局自带稳定图标，不依赖外部字体图标或网络资源。

分层卡片 2–6 个，流程 2–8 步。不同位置使用不同文案上限，见字段规格，不用“中文最多十字”限制所有文字。完整图形中的颜色由生成器统一管理。

来源为示意时，在周围解释中说明；不要将流程概览当作真实执行记录。本 Skill 自带渲染器，不依赖任何宿主插件；原先在 DSH 对话里渲染 `dsh-diagram` 代码块的插件（`diagram-card`）已于 2026-10-28 退役，它的能力由这里接管——代码块不再是交付形态，图就是文件。
