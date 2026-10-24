# 豆包工作里图片到底能不能显示（四组对照）

> 环境：macOS / DoubaoWork.app 2.33.5 / 自建最小 MCP 服务（返回红色方块 PNG）
> 实测日期：2026-10-24
> 验证方式：DOM 断言页面 `<img>` 数量与自然尺寸 + 服务端日志确认 `tools/call` 发生过 + 截图
> 结论：已验证 —— MCP 工具返回的图片**不渲染**；只有公网 HTTPS 地址的 Markdown 图片会渲染

## 权限前提

| 前提 | 说明 |
|---|---|
| 能修改 App 内插件设置 | 装连接器需要，无系统权限要求 |
| 有一个公网 HTTPS 可访问的图片 | 验证"能显示"这一组必需 |
| 能读 DOM | 需要 CDP 接管，见 [cdp-takeover.md](./cdp-takeover.md) |

## 操作手段

一个最小 MCP 服务，只暴露一个 `echo_image` 工具，返回两张内容块：

1. `text`："下面是一张红色方块图片"
2. `image`：PNG 的 base64（240×140，红色边框）

把服务挂进 App（见 [mcp-connector.md](./mcp-connector.md)），然后在对话里让它调用这个工具。
另外两组不用 MCP：直接在对话里要求它原样输出一段 Markdown 图片语法，分别用公网地址和本机地址。

## 如何验证

**四组对照，都是实际跑过的：**

| # | 测什么 | 结果 | 证据 |
|---|---|---|---|
| 1 | 自定义连接器（本机 HTTP） | ✅ 能装、能握手 | 服务端日志：`initialize` / `tools/list` |
| 2 | 工具返回 `image` 内容 | ❌ **不渲染** | `tools/call` 确实发生了；页面 `<img>` 数量为 **0**；模型仍回复"已正常显示" |
| 3 | Markdown 图片 · **公网 HTTPS** 地址 | ✅ 渲染 | DOM 出现对应 `<img>`，且取到实际宽高 |
| 4 | Markdown 图片 · **本机地址** | ❌ 被拦 | 只出现占位图（`data:` 形态的 fallback），取不到自然尺寸 |

判定方法统一为 DOM 断言：

```js
[...document.querySelectorAll('img')]
  .map(i => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight }))
  .filter(x => x.w > 40)
```

`naturalWidth === 0` 就是没渲染成功（占位图也是这个特征）。

## 回退

- 删掉测试连接器和测试对话。
- 图片内容只在对话历史里，删对话即消失；没有写本地文件的地方。

## 何时别用

- **想让 App 内联显示图**：不要走 MCP 返回图片内容这条路，直接给公网 HTTPS 图片地址。
- **没有公网图床**：就别在这个 App 里做图表类交付，改用能本地渲染的宿主。
- **只是要一张附件**：直接上传文件，比 MCP 绕一圈可靠。

## 已知坑

- **模型会撒谎**：第 2 组里它明确说"返回的红色方块图片如上所示，已正常显示"，而 DOM 里一张图都没有。**必须用 DOM 断言复核，不能信文字描述。**
- **占位图会骗过肉眼看宽高**：本地地址那一组，元素有尺寸但 `naturalWidth` 是 0，说明渲染失败。
- **本机地址被拦**：`http://127.0.0.1/...` 这种也不行，渲染层会拦，表现为占位图。
- **结论要反过来看**：不是"这个 App 不能显示图片"，而是"它只认公网 HTTPS 的 Markdown 图片"。

## 可复现步骤

1. **MCP 工具返回两种内容块**：

   ```
   content: [
     { type: 'text',  text: '下面是一张图片：' },
     { type: 'image', data: '<base64>', mimeType: 'image/png' }
   ]
   ```

2. **挂连接器 → 对话里触发调用**（见 [mcp-connector.md](./mcp-connector.md)）。
3. **立刻做 DOM 断言，不要看模型怎么说**：

   ```js
   [...document.querySelectorAll('img')]
     .map(i => ({ w: i.naturalWidth, h: i.naturalHeight, src: (i.currentSrc || i.src).slice(0, 60) }))
     .filter(x => x.w > 40)
   ```

   观察：返回空数组 → 没渲染；`w === 0` 的条目 → 是占位图。

4. **对照 A（公网 HTTPS）**：在对话里要求原样输出
   `![t](https://<公网域名>/<路径>.png)`，再跑同一条断言。观察：出现 `w > 0` 的真实图片。
5. **对照 B（本机地址）**：换成 `![t](http://127.0.0.1:<port>/x.png)`，再断言。
   观察：`<img>` 元素存在但 `naturalWidth === 0`，即被拦。

## 踩坑实录

| 症状 | 原因 | 修法 |
|---|---|---|
| 图片列表里出现 `data:image/svg+xml` 的条目 | 加载失败后的占位图 | 换成公网 HTTPS 地址 |
| 元素看起来有宽高，但没有图 | 占位图也占位，`naturalWidth` 才是判据 | 用 `naturalWidth` 判定，别看 CSS 尺寸 |
| 模型回复"已正常显示" | 幻觉，它看不见渲染结果 | 只信 DOM 断言 |
| 本机地址被拦 | 渲染层不允许本机资源 | 必须公网 HTTPS |
