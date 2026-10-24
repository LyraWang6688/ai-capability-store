# 豆包工作里图片到底能不能显示（四组对照）

> 环境：macOS / DoubaoWork.app 2.33.5 / 自建最小 MCP 服务（返回红色方块 PNG）
> 实测日期：2026-10-24
> 验证方式：DOM 断言 `img` 数量与 `naturalWidth` + 服务端日志确认 `tools/call` 发生过 + 截图
> 结论：已验证 —— MCP 工具返回的图片**不渲染**；只有公网 HTTPS 地址的 Markdown 图片会渲染

## 权限前提

| 前提 | 说明 |
|---|---|
| 能改 App 内插件设置 | 装连接器需要，无系统权限要求 |
| 有一个公网 HTTPS 可访问的图片 | 验证"能显示"这一组必需 |
| 能读 DOM | 需要 CDP 接管，见 [cdp-takeover.md](./cdp-takeover.md) |

## 工具清单

| 工具 | 类型 | 用来做什么 | 前置条件 |
|---|---|---|---|
| 最小 MCP server（返回 text + image） | 自建服务 | 造出"工具返回图片"这个场景 | 能被 App 连上，见 [mcp-connector.md](./mcp-connector.md) |
| `Runtime.evaluate` | CDP 方法 | DOM 断言：`img` 数量、`naturalWidth` | 已接管 App |
| 公网 HTTPS 图床 | 外部资源 | 做"能显示"的对照组 | 图片可公开访问 |
| `curl` | CLI | 先确认图片地址本身可达 | 网络 |

## 可复现步骤

1. **让工具返回两种内容块**：

   ```
   content: [
     { type: 'text',  text: '下面是一张图片：' },
     { type: 'image', data: '<base64>', mimeType: 'image/png' }
   ]
   ```

2. **挂连接器 → 对话里触发调用**，然后立刻做 DOM 断言：

   ```js
   [...document.querySelectorAll('img')]
     .map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: (i.currentSrc || i.src).slice(0, 60) }))
     .filter(x => x.w > 40)
   ```

   *观察*：返回空数组 → 没渲染；`w === 0` 的条目 → 是占位图。（实测：空数组。）

3. **对照 A（公网 HTTPS）**：对话里要求原样输出 `![t](https://<公网域名>/<路径>.png)`，
   再跑同一条断言。*观察*：出现 `w > 0` 的真实图片。

4. **对照 B（本机地址）**：换成 `![t](http://127.0.0.1:<port>/x.png)`，再断言。
   *观察*：`<img>` 元素存在但 `naturalWidth === 0`，即被拦。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 图片列表里出现 `data:image/svg+xml` 的条目 | 加载失败后的占位图 | 换成公网 HTTPS 地址 |
| 元素看起来有宽高，但没有图 | 占位图也占位，`naturalWidth` 才是判据 | 用 `naturalWidth` 判定，别看 CSS 尺寸 |
| 模型回复"已正常显示" | 幻觉，它看不见渲染结果 | 只信 DOM 断言 |
| 本机地址被拦 | 渲染层不允许本机资源 | 必须公网 HTTPS |

## 何时别用

- **想让 App 内联显示图**：不要走 MCP 返回图片内容，直接给公网 HTTPS 图片地址。
- **没有公网图床**：别在这个 App 里做图表类交付，换成能本地渲染的宿主。
- **只是要一张附件**：直接上传文件，比 MCP 绕一圈可靠。
