---
name: wechat-html-css-layout
description: Generate brand-consistent WeChat Official Account article body HTML fragments for 要AI不释手. Use when the user asks for 公众号排版, 微信公众号排版, HTML+CSS, 壹伴可复制排版, WeChat draft/article API content, content_html, Supabase content_html, or preview HTML for a WeChat article. Always distinguish official publishing HTML fragments from preview-only HTML pages.
---

# WeChat HTML/CSS Layout

Generate WeChat Official Account article body HTML fragments for 要AI不释手. The output should be usable in WeChat editor / 壹伴 and suitable as the article `content` body fragment for WeChat draft/article API workflows.

## Trigger behavior

When the user asks to format, layout, preview, generate, update, or write WeChat Official Account article HTML, this skill must be used.

Trigger examples include but are not limited to:

- “排版”
- “帮我排版”
- “把这篇文章排版”
- “生成公众号排版”
- “生成微信公众号排版”
- “生成公众号 HTML”
- “生成微信公众号 HTML”
- “转成公众号 HTML”
- “转成微信公众号 HTML”
- “转换成公众号排版”
- “按照 one page 排版”
- “按照品牌体系排版”
- “按照公众号格式排版”
- “做成公众号可用的 HTML”
- “输出公众号 HTML 片段”
- “生成 content_html”
- “写入 content_html”
- “更新 content_html”
- “写入 Supabase 的 content_html”
- “生成微信公众号预览”
- “做微信公众号预览”
- “生成可预览的公众号 HTML”

Default behavior:

1. Generate the official WeChat HTML fragment first.
2. If the user asks for preview, generate a separate preview HTML page.
3. Clearly label which output is for publishing and which output is only for preview.
4. Never write preview HTML into Supabase `content_html`.
5. Never confuse the preview page with the official WeChat HTML fragment.

## Source hierarchy

Use the bundled references as separate layers, not substitutes for one another:

1. Read `references/shared-brand-context.md` for account positioning, latest tags, GEO strategy, voice principles, official color system, and the latest column/sub-column system.
2. Read `references/wechat-layout-context.md` for concrete layout rules, typography, module styling, mobile readability, WeChat editor compatibility, and API-ready HTML-fragment constraints.
3. Read `references/wechat-html-template.md` when a reusable HTML structure or module pattern is needed.
4. Read `references/ending-image-rules.md` when inserting a fixed column ending image or placeholder.

## Stable strategy

GEO / AI-Friendly Writing remains the long-term content strategy. Articles should be easy for both human readers and AI systems to understand, retrieve, summarize, and cite.

## Stable assets

Brand color system and article structure remain unchanged. Use the official color system exactly: #8DAA91, #C2A878, #2F3437, #666666, #6B6B6B, #F7F6F3, #EEF1EC, #DDE2DA, #E7ECE6, #F3F5F1, #66786B.

## Latest account positioning

「要AI不释手」记录一个非技术背景知识工作者，如何在真实项目中与 AI 协作，把想法、工具、知识和流程，逐步变成可用的产品、系统和解决方案。

Core sentence: AI 是很强大的工具，但工具本身不是答案。真正重要的是：找到真实场景、识别具体价值，并设计可落地的解决方案。

## Latest column system

- AI 协作实验
  - 造物笔记：从 0 到 1，把想法做成小产品 / 小系统
  - 从卡点到解法：问题拆解、技术卡点、方案选择
  - 工具炼金术：AI 工具组合、提效实践、工作流整合
  - 概念补给站：Skill、CLI、部署、API、Token 等基础概念讲解
- 边走边想：个人成长、情绪复盘、职业思考、长期主义
- 书籍推荐：阅读输入、认知补给
- 热钱之外：投资理性、市场观察、普通投资者判断力训练
- AI 简报：AI 资讯整理、趋势观察、机会识别、劳动力市场影响

## Reading info rule

Do not add a fixed reading info module unless the user explicitly asks for it.

Do not default-generate:

- reading time
- article column
- keywords
- suitable readers
- reading info card

If the user only asks for article layout, do not infer reading time, target readers, keywords, column metadata, or other reading info.

## Hard rules

- Output WeChat Official Account article body HTML fragments only, not a full standalone HTML document, unless the user explicitly asks for preview HTML.
- Do not output `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, `<style>`, or `<script>` in the official publishing HTML fragment.
- Use inline CSS only, through `style` attributes on supported tags.
- Do not rely on external CSS, JavaScript, web fonts, interactive behavior, or custom classes.
- Do not use external web fonts, embed font files, or rely on `@font-face`.
- Use stable `section + p + span + img` structures.
- Avoid unnecessary complex nesting.
- Prefer card-style comparison blocks over tables for rendering stability.
- Use the fixed color system exactly; do not redesign the brand colors.
- Keep mobile reading comfortable.
- Use the latest column system, especially 《AI 协作实验》 and its four sub-columns.
- Insert the fixed column ending image placeholder when the real URL is not available.
- For images, never use local file paths such as `/mnt/data/...` in the final HTML.
- Use placeholders such as `{{IMAGE_01_URL}}` or column-specific ending image placeholders when the final WeChat image URL is unavailable.
- When preparing API-ready HTML, list all image placeholders before the HTML block so images can be uploaded and replaced before draft creation.
- Never write preview HTML into Supabase `content_html`; only write the official WeChat HTML fragment.

## Workflow

1. Identify article column / sub-column if possible.
2. Convert article structure into WeChat modules.
3. Add content summary module when appropriate. Do not add a fixed reading info module unless the user explicitly asks for it.
4. Format headings, body paragraphs, quote cards, method cards, comparison cards, and image blocks.
5. Add the correct ending image module or placeholder according to `references/ending-image-rules.md`.
6. Before the HTML, list missing image placeholders and the intended image for each placeholder.
7. Return a WeChat-compatible HTML fragment, not a full HTML page.
8. If the user asks for preview, return the official publishing fragment first, then a clearly labeled preview-only HTML page.

## Output

Return:

1. A short placeholder list when assets are missing, especially image URLs.
2. A complete WeChat article body HTML fragment ready for WeChat editor / 壹伴 copying and suitable for use as a WeChat draft/article API `content` field body fragment.
3. A separate preview-only HTML page only when the user explicitly asks for preview.

Do not return complete webpage HTML for the official publishing fragment. Do not wrap the official publishing fragment in `<html>`, `<head>`, or `<body>`.


## 强制排版规则（v2 · 必须遵守，否则粘进微信编辑器会走形）

1. **禁止 `<h1>`–`<h6>`**：标题一律用 `section`/`p` + 最内层 `<span style="font-size:16px">`。
   （原因：微信编辑器会把标题标签转成 `p`，字号被平台默认样式接管 → 出现"标题和正文一样大"。）
2. **标题：16px、左对齐、加粗**（编号 01/02/… 同样是 16px）。
3. **正文：15px、左对齐、`text-indent:2em`**（首行缩进两字符）。
4. **卡片内文字：15px、左对齐、`text-indent:0`**；**居中金句：15px、`text-align:center`**。
5. **不使用 `text-align:justify`**。
6. **图片：居中容器 + `width:100%` + `alt`**；结尾用对应栏目的固定图。
7. 平台限制：标题 ≤ 64 字、摘要 ≤ 120 字、正文 ≤ 20000 字且 ≤ 1MB、封面必填（2.35:1）。

详细规则见 `references/wechat-layout-context.md`；可直接套用的模块见 `references/wechat-html-template.md`（v2）。
