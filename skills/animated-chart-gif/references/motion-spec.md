# 事件驱动动画格式

`render_motion.py input.json output.html|output.gif`。HTML 无外部资源，不依赖 ECharts；GIF 需要 Pillow。数据图表需要更复杂交互时可另编 ECharts 动画，不能把此生成器称为 ECharts 实现。

## 字段

- `title`：必填，图解标题。
- `source`：必填，来源简述；示例写“示意路径，非运行记录”。
- `nodes`：2–10 个，按画面阅读顺序排列；每项 `id`（唯一字符串）、`label`、可选 `note`。
- `events`：2–40 个，按演示顺序排列；每项 `node`（已有 id）、`caption`、可选 `duration`（秒，0.6–12，默认 1.6）、`status`（active / failed / complete）。至少经过两个不同节点。
- `font_path`：可选，GIF 中文字体路径。内置探测 macOS Hiragino / STHeiti 与 Linux Noto CJK。

相邻向下节点之间画直线，返回或跨步沿右侧连线。事件顺序是显式演示路径，不自动推断业务逻辑。`failed` 显示异常色，但并不自动重试；重复事件决定重试过程。`complete` 显示完成色，但不截断后续事件；最后一个事件播放结束后 HTML 暂停，GIF 留出阅读时间并整体循环。

HTML 带播放/暂停、重播、进度条、速度选择。减少动态效果偏好下默认暂停，仍可手动播放；不自动发布。GIF 默认 10fps，末尾额外停留 1.2 秒；画布宽 960，高度按节点数增长，不设通用文件体积上限。需要较小成品时减少事件、分场景或改用 HTML，避免缩到文字不可读。

示例 `assets/examples/loop.json` 展示第一次检查失败后回到观察、第二次通过；`timeline.json` 展示三个阶段，时间间隔不按真实比例播放。

## 检查重点

未知节点、重复 ID、非法状态、非有限/越界时长、过长文案和非动画输出后缀应拒绝。来源文本、标题和说明不得作为 HTML/脚本执行。时间线中的相等停留时间只代表阅读节奏，不能暗示真实等间隔。
