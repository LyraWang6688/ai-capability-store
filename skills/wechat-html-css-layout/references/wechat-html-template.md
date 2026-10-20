# WeChat HTML Fragment Template（v2 · 按微信官方/编辑器兼容要求适配）

Use these patterns to build WeChat Official Account article body HTML fragments. Do not output full standalone HTML pages.

> **v2 关键变化（务必遵守）**
> 1. **禁止 `<h1>`–`<h6>`** —— 微信编辑器会把标题标签转成 `<p>`，转换过程中**字号被平台默认样式接管**，结果就是"标题和正文一样大"。
> 2. **字号必须写在最内层 `<span>` 上**（`15px` / `16px`），不要只写在 `section`、`p` 上；外层被改写也不会走形。
> 3. 正文：**左对齐 + 首行缩进两字符**（`text-align:left;text-indent:2em`），不再使用 `text-align:justify`。
> 4. 图片：**居中容器 + `width:100%`（自适应）**，并尽量写 `alt`（GEO/AI 检索需要）。

## 硬规则速查

| 元素 | 字号 | 对齐 | 缩进 |
|---|---|---|---|
| 编号（01/02…） | **16px**（span 上） | left | 无 |
| 小标题 | **16px**（span 上） | left | 无 |
| 正文段落 | **15px**（span 上） | **left** | **text-indent:2em** |
| 卡片内文字 | **15px**（span 上） | left | `text-indent:0` |
| 居中金句 | **15px**（span 上） | **center** | 无 |
| 图注 | 13px | center | 无 |

## Outer container

```html
<section style="margin:0 auto;padding:1px 0;background:#F7F6F3;color:#2F3437;font-size:15px;font-family:'Source Han Sans SC','Noto Sans CJK SC',-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',Arial,sans-serif;line-height:1.9;letter-spacing:0.8px;">
  <!-- article modules here -->
</section>
```

> 外层只作兜底基准；**每个可见文字块仍必须带自己的内层 span 字号**。

## Title card（可选）

文章标题通常填在微信"标题"字段，不必再写进正文；如需在正文内出现标题卡，按 **16px** 处理：

```html
<section style="margin:24px 8px;padding:22px 18px;background:#EEF1EC;border:1px solid #DDE2DA;border-radius:14px;">
  <p style="margin:0 0 8px;color:#8DAA91;font-size:14px;font-weight:700;letter-spacing:1.2px;text-align:left;text-indent:0;"><span style="font-size:14px;">栏目 / 子栏目</span></p>
  <section style="margin:0;color:#2F3437;font-size:16px;line-height:1.5;font-weight:700;text-align:left;"><span style="font-size:16px;">文章标题</span></section>
</section>
```

## Content summary card

```html
<section style="margin:24px 8px;padding:18px;background:#EEF1EC;border:1px solid #DDE2DA;border-radius:12px;">
  <p style="margin:0 0 8px;color:#66786B;font-size:14px;font-weight:700;text-align:left;text-indent:0;"><span style="font-size:14px;">内容概要</span></p>
  <p style="margin:0;color:#2F3437;font-size:15px;line-height:1.85;text-align:left;text-indent:0;"><span style="font-size:15px;">这里放文章摘要或导读内容。</span></p>
</section>
```

## Body paragraph

```html
<p style="margin:16px 8px;font-size:15px;line-height:1.95;color:#2F3437;text-align:left;text-indent:2em;"><span style="font-size:15px;">正文内容。</span></p>
```

需要强调时，把强调词单独包一层内层 span：

```html
<p style="margin:16px 8px;font-size:15px;line-height:1.95;color:#2F3437;text-align:left;text-indent:2em;"><span style="font-size:15px;">前半句，<span style="font-size:15px;font-weight:bold;">这里是重点</span>，后半句。</span></p>
```

## Numbered heading

```html
<section style="margin:32px 8px 16px;">
  <p style="margin:0 0 6px;color:#8DAA91;font-size:16px;font-weight:700;letter-spacing:1px;text-align:left;text-indent:0;"><span style="font-size:16px;">01</span></p>
  <section style="margin:0;color:#2F3437;font-size:16px;line-height:1.5;font-weight:700;text-align:left;"><span style="font-size:16px;">小标题</span></section>
</section>
```

## Core idea card

```html
<section style="margin:24px 8px;padding:18px;background:#E7ECE6;border-left:4px solid #8DAA91;border-radius:12px;">
  <p style="margin:0;color:#2F3437;font-size:15px;line-height:1.85;font-weight:600;text-align:left;text-indent:0;"><span style="font-size:15px;">核心观点。</span></p>
</section>
```

## Centered quote / 金句 card

```html
<section style="margin:24px 8px;padding:18px;background:#E7ECE6;border-left:4px solid #8DAA91;border-radius:12px;">
  <p style="margin:0;color:#2F3437;font-size:15px;line-height:1.8;font-weight:600;text-align:center;text-indent:0;"><span style="font-size:15px;">居中金句。</span></p>
</section>
```

## Method / checklist card

```html
<section style="margin:24px 8px;padding:18px;background:#F3F5F1;border:1px solid #DDE2DA;border-radius:12px;">
  <p style="margin:0 0 8px;color:#66786B;font-size:14px;font-weight:700;text-align:left;text-indent:0;"><span style="font-size:14px;">方法 / 清单</span></p>
  <p style="margin:0;color:#2F3437;font-size:15px;line-height:1.85;text-align:left;text-indent:0;"><span style="font-size:15px;">具体内容。</span></p>
</section>
```

## Regular information card

```html
<section style="margin:24px 8px;padding:18px;background:#EEF1EC;border:1px solid #DDE2DA;border-radius:12px;">
  <p style="margin:0 0 10px;color:#2F3437;font-size:15px;line-height:1.85;text-align:left;text-indent:0;"><span style="font-size:15px;">信息卡片内容（多行时每行一个 p）。</span></p>
  <p style="margin:0;color:#2F3437;font-size:15px;line-height:1.85;text-align:left;text-indent:0;"><span style="font-size:15px;">第二行。</span></p>
</section>
```

## Card-style comparison module（优先于 table）

```html
<section style="margin:24px 8px;padding:18px;background:#F3F5F1;border:1px solid #DDE2DA;border-radius:12px;">
  <p style="margin:0 0 8px;color:#6B6B6B;font-size:14px;text-align:left;text-indent:0;"><span style="font-size:14px;">以前 · 工具中心</span></p>
  <p style="margin:0 0 18px;color:#2F3437;font-size:15px;line-height:1.9;text-align:left;text-indent:0;"><span style="font-size:15px;">我有什么工具，就看看它能帮我做什么。</span></p>
  <p style="margin:0 0 8px;color:#6B6B6B;font-size:14px;text-align:left;text-indent:0;"><span style="font-size:14px;">现在 · 能力中心</span></p>
  <p style="margin:0;color:#2F3437;font-size:15px;line-height:1.9;font-weight:600;text-align:left;text-indent:0;"><span style="font-size:15px;">我要完成这件事，因此我需要组合哪些能力？</span></p>
</section>
```

> 同一组对照，标签样式必须一致（都用 14px 灰字，或都用正文样式），不要一个灰一个黑。

## Image module（居中 + 自适应）

```html
<section style="margin:24px 8px;text-align:center;">
  <img src="{{IMAGE_01_URL}}" alt="图片语义说明（GEO 需要，写清图里是什么）" style="display:block;width:100%;height:auto;border-radius:12px;" />
  <p style="margin:10px 0 0;color:#96A096;font-size:13px;text-align:center;text-indent:0;"><span style="font-size:13px;">▲ 图注（可选）</span></p>
</section>
```

## Fixed ending image module

```html
<section style="margin:32px 8px 0;text-align:center;">
  <img src="COLUMN_ENDING_IMAGE_URL_PLACEHOLDER" alt="栏目固定结尾图" style="display:block;width:100%;height:auto;border-radius:12px;" />
</section>
```
