# wechat-article

**一次做一篇公众号文章的完整流程。** 这个目录只有引用，没有实现。

```text
orchestrations/manual/dsh/wechat-article/   ← 模式=manual（人说一句就做），目标=dsh
```

```text
1-write    → skills/geo-content
2-layout   → skills/wechat-html-css-layout
3-chart    → skills/animated-chart-gif
4-upload   → external-capabilities/mcp/wechat-draft-mcp
```

上面的软链和 `orchestrations/registry.yaml` 里的 `steps` 是同一份事实的两个视图。
验证器保证两者一致 —— 因为 **git 不会告诉你软链断了**。

---

## ⚠️ 衔接规则：两个下游对图片的要求是相反的

| 谁 | 怎么要图片 |
|---|---|
| `skills/wechat-html-css-layout` | 用占位符 `{{IMAGE_01_URL}}`，原文写着 *"never use local file paths in the final HTML"* |
| `external-capabilities/mcp/wechat-draft-mcp` | 用**相对本地路径** `images/fig1.png`，工具自动上传并替换 |

**所以先排版再上传，会裂图或上传失败。**

```text
只是排版给人看（粘进编辑器 / 壹伴）
  → 图片写 {{IMAGE_01_URL}}，最后手动替换

要走第 4 步上传
  → 图片直接写 images/fig1.png，并在文章包内放 cover.png
```

**这条规则只写在这里** —— 因为它是两个资产之间的事，不属于它们任何一方。

---

## 每一步的产出喂给谁

```text
write    → 正文 Markdown
layout   ← 正文 Markdown          → body HTML
chart    ← body HTML 里的数据点   → 配图 GIF
upload   ← body HTML + 图片文件   → 公众号草稿
```

## 不做的事

- 不复制任何排版规则 / 上传逻辑 / 动图模板
- 不定义新的流程步骤 —— 加一步就是改 `registry.yaml` 的 `steps`
- 不负责定时触发（那是 `automations/`）
