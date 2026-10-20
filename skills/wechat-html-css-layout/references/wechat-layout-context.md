# WeChat HTML Fragment Layout Context

## Layout goal

Generate WeChat Official Account article body HTML fragments that can be copied into WeChat Official Account editors or tools such as 壹伴, and can also be used as the `content` body fragment in WeChat draft/article API workflows.

The style must match the brand identity of 要AI不释手: clean, restrained, low-saturation, trustworthy, and suitable for long-form reading.

## Compatibility rules

- Output HTML fragments only, not full standalone HTML documents.
- Do not output `<!DOCTYPE html>`, `<html>`, `<head>`, `<body>`, `<style>`, or `<script>` in official publishing fragments.
- Use inline CSS only.
- Do not rely on external CSS, JavaScript, web fonts, interactive behavior, or custom classes.
- Do not use external web fonts, embed font files, or rely on `@font-face`.
- Prefer stable `section + p + span + img` structures.
- **Never use `<h1>`–`<h6>`**：微信编辑器会把它们转成 `<p>`，字号被平台默认样式接管 → 标题与正文看起来一样大。
- **字号必须内联到最内层 `<span>`**：只写在 `section`/`p` 上不可靠（平台或编辑器可能改写外层）。
- Avoid deeply nested complex HTML.
- Prefer card-style comparison blocks over `<table>` when possible.
- Every card module must include background color, padding, border or border-left, and border-radius.
- Use mobile-first readability.
- If the user asks for preview, produce preview-only HTML separately and clearly label it.
- Never write preview HTML into Supabase `content_html`; only write the official WeChat HTML fragment.

## Fixed color tokens

- Page background: #F7F6F3
- Body text: #2F3437
- Primary brand: #8DAA91
- Highlight text: #66786B
- Light card background: #EEF1EC
- Core idea background: #E7ECE6
- Method background: #F3F5F1
- Divider: #DDE2DA
- Annotation: #6B6B6B

## Typography

The visual target font is 思源黑体 / Source Han Sans SC.

Because WeChat Official Account articles may not reliably load custom or external fonts, use a compatible system font stack that approximates 思源黑体:

```css
font-family:'Source Han Sans SC','Noto Sans CJK SC',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;
```

Do not use external web fonts.

Do not embed font files.

Do not rely on `@font-face`.

Typography should feel clean, restrained, readable, and close to the visual tone of 思源黑体.

- **标题（含编号）：16px，必须写在最内层 `<span>` 上；禁止 `<h1>`–`<h6>`。**
- **正文与卡片文字：15px，同样写在最内层 `<span>` 上。**
- 行高：1.85–1.95；字距：0.6–2px（按模块）。
- 对齐：正文/卡片一律 **`text-align:left`**；居中金句用 `text-align:center`；**不使用 `text-align:justify`**（中文会被拉伸字距）。
- 首行缩进：**正文段落 `text-indent:2em`**（首行缩进两字符）；卡片/模块内文字 `text-indent:0`。

## Spacing

Follow the one page visual template spacing logic.

Use module-level horizontal margins rather than relying only on the outer container.

Recommended spacing:

- Outer container: `padding:1px 0;background:#F7F6F3;`
- Title card: `margin:24px 8px;`
- Content summary card: `margin:24px 8px;`
- Body paragraph: `margin:16px 8px;`
- Numbered heading: `margin:32px 8px 16px;`
- Core idea / quote card: `margin:24px 8px;padding:18px 18px;`
- Method / checklist card: `margin:24px 8px;padding:18px;`
- Regular information card: `margin:24px 8px;padding:18px;`
- Image module: `margin:24px 8px;`
- Fixed ending image module: `margin:32px 8px 0;`

Avoid using `margin:16px 0` for body paragraphs unless the paragraph is inside a card module.

## Reading info module

Do not add a fixed reading info module unless the user explicitly asks for it.

Do not default-generate:

- reading time
- article column
- keywords
- suitable readers
- reading info card

If the user only asks for article layout, do not infer reading time, target readers, keywords, column metadata, or other reading info.

## Required modules

Use modules as needed:

1. outer container
2. content summary
3. body paragraph
4. core idea / quote module
5. numbered section heading
6. method/checklist module
7. regular information card
8. card-style comparison module
9. image module
10. fixed column ending image module

Only add reading info when the user explicitly asks for it.

## Image URL rules

- Do not use local file paths in the final HTML.
- If a final WeChat image URL is unavailable, use placeholders such as `{{IMAGE_01_URL}}`, `{{COVER_IMAGE_URL}}`, or the column-specific ending image placeholders.
- Before the HTML block, list all image placeholders and describe what image should replace each placeholder.
- For API workflows, images should be uploaded first and the returned/usable image URLs should replace placeholders before draft creation.

## Ending image rule

Every article should end with the fixed image for its column. Do not generate additional fixed text ending unless explicitly requested.

Use this HTML pattern and replace image URL when available:

```html
<section style="margin:32px 8px 0;text-align:center;">
  <img src="COLUMN_ENDING_IMAGE_URL_PLACEHOLDER" style="display:block;width:100%;height:auto;border-radius:12px;" />
</section>
```

If the real URL is unavailable, output the relevant column placeholder and list which column image is needed before the HTML.


## 平台硬限制（以微信官方文档为准）

| 项 | 限制 | 说明 |
|---|---|---|
| 标题 | ≤ 64 字 | 草稿/发布接口字段 |
| 摘要（digest） | ≤ 120 字 | 微信"摘要"字段上限 |
| 正文 | ≤ 20000 字，且正文 HTML ≤ 1MB | **字数是纯文本字数，不是 HTML 源码长度** |
| 封面 | 必须提供 `thumb_media_id`；首图 2.35:1（900×383） | 分享缩略图 1:1，按居中等比裁剪 |
| 正文图片 | 必须先上传图床（`uploadimg`）拿到 `mmbiz` 地址，再写入 HTML | 不可用本地路径或站外直链 |
| 外链 | 正文内不能随意插入外部链接 | 出口是"阅读原文" |

> 参考：微信开放文档 `developers.weixin.qq.com`（草稿箱 / 素材管理相关页面）。

## 强制排版规则（v2 · 按官方与编辑器兼容性）

1. **禁止 `h1`–`h6`**：编辑器会把标题标签转成 `p`，字号被接管 → 标题和正文一样大。
2. **字号写在最内层 `span`**：`<span style="font-size:16px">`（标题）/ `15px`（正文与卡片文字）。
3. **标题：16px + 左对齐 + 加粗**（含编号 01/02/…）。
4. **正文：15px + 左对齐 + `text-indent:2em`**。
5. **卡片内文字：15px + 左对齐 + `text-indent:0`**；**居中金句：15px + `text-align:center`**。
6. **不用 `text-align:justify`**，统一 `left`。
7. **图片：居中容器 + `width:100%`（自适应）+ `alt`**。
8. 结尾必须是对应栏目的固定图（见 `ending-image-rules.md`）。

## 上传前自检清单

- [ ] 全文没有 `h1`–`h6`
- [ ] 每个标题的最内层 `span` 都是 `font-size:16px`
- [ ] 每个正文段的最内层 `span` 都是 `font-size:15px`，且 `p` 上有 `text-indent:2em;text-align:left`
- [ ] 卡片内文字 `text-indent:0`
- [ ] 没有 `text-align:justify`
- [ ] 图片都居中 + `width:100%` + 有 `alt`
- [ ] 正文纯文本字数 ≤ 20000，正文 HTML ≤ 1MB
- [ ] 标题 ≤ 64 字，摘要 ≤ 120 字
- [ ] 结尾有对应栏目的固定图
