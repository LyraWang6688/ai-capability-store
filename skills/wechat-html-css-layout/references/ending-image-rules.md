# Ending Image Rules

Column ending images are fixed assets and should be inserted at the end of an article based on the latest column system in `shared-brand-context.md`. Do not use removed or legacy columns.

Do not generate additional fixed text ending by default unless the user explicitly asks for a textual ending.

## Latest column mapping

- 《AI 协作实验》, including sub-columns 造物笔记、从卡点到解法、工具炼金术、概念补给站: `AI_COLLABORATION_EXPERIMENT_ENDING_IMAGE_URL_PLACEHOLDER`
- 《边走边想》: `WALKING_THINKING_ENDING_IMAGE_URL_PLACEHOLDER`
- 《书籍推荐》: `BOOK_RECOMMENDATION_ENDING_IMAGE_URL_PLACEHOLDER`
- 《热钱之外》: `HOT_MONEY_BEYOND_ENDING_IMAGE_URL_PLACEHOLDER`
- 《AI 简报》: `AI_BRIEF_ENDING_IMAGE_URL_PLACEHOLDER`

## HTML pattern

Use this pattern and replace the placeholder with the real image URL when available:

```html
<section style="margin:32px 8px 0;text-align:center;">
  <img src="COLUMN_ENDING_IMAGE_URL_PLACEHOLDER" style="display:block;width:100%;height:auto;border-radius:12px;" />
</section>
```

If the column is unknown, ask the user to select a column or use `COLUMN_ENDING_IMAGE_URL_PLACEHOLDER` and mark it as pending.
