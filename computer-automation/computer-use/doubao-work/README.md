# 豆包工作（Doubao Work）— App 级总览

> 环境：macOS / DSH 桌面端 0.2.1-rc.2 / DoubaoWork.app 2.33.5（Chromium 147 内核）
> 实测日期：2026-10-24
> 验证方式：CDP 读 `/json/version` 与页面列表 + DOM 断言 + 截图 + 自建 MCP 服务端日志
> 结论：已验证 —— CDP 可完全驱动该 App；MCP 连接器可用，但工具返回的图片不渲染

一个 App 有多条操作路径时，按主题拆成多篇，避免单文件无限增长。**先读总览，再跳到需要的那篇。**

## 这个 App 的特点（决定了怎么操作）

| 特征 | 值 | 影响 |
|---|---|---|
| 内核 | Chromium 147 | 可以用 CDP 驱动，不依赖辅助功能 |
| 辅助功能授权 | 本机未授权（`-10004`） | AppleScript 模拟键鼠全废；截屏仍可用 |
| 插件体系 | 技能 / 连接器 / 伙伴 三件套（实测 179 / 16 / 14） | 连接器支持自定义 MCP（HTTP）；技能可对话新建或上传 |
| 自定义连接器范围 | **仅本机**（表单原文：「自定义连接器仅支持在本地电脑中使用」） | 本机 HTTP 地址能连上，不需要公网服务器 |
| 图片显示 | 只认公网 HTTPS 地址的 Markdown 图片 | MCP 工具返回图片内容不显示 |

## 主题索引

| 文档 | 主题 | 什么时候读 |
|---|---|---|
| [cdp-takeover.md](./cdp-takeover.md) | 用 CDP 接管 App（启动参数、端口、DOM 断言） | 要自动化点按、读界面状态、批量截图时 |
| [mcp-connector.md](./mcp-connector.md) | 添加自定义 MCP 连接器并确认握手 | 要把自己的 MCP 服务挂进这个 App 时 |
| [image-rendering.md](./image-rendering.md) | 图片渲染的真实边界（四组对照） | 想在这个 App 里显示图片 / 图表时 |
| [custom-skill.md](./custom-skill.md) | 技能的入口与三条来源（对话新建 / 上传 / 连接器是不同东西） | 想让它记住一套固定流程时 |

## 一句话选路

- 只是想读页面内容 → 不要开 CDP，走 `web_fetch` 或官方 API。
- 想让它调用你的服务 → 看 [mcp-connector.md](./mcp-connector.md)。
- 想让它显示一张图 → 先看 [image-rendering.md](./image-rendering.md)，结论是「必须有公网 HTTPS 地址」。
- 想让它复用一套流程 → 看 [custom-skill.md](./custom-skill.md)，注意技能与连接器不是一回事。

## 通用回退

- CDP 接管：结束带调试参数的进程，`open -a DoubaoWork` 正常启动即可恢复。
- 加过的连接器 / 产生的测试对话：用完删掉，别留在个人列表里。
