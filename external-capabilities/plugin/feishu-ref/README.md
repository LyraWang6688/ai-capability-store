# feishu-ref

**在 DSH 输入框点「＋ 引用」，搜索你的飞书文档 / 多维表格，选中后把链接插入输入框。**

不需要复制粘贴 URL：选中一条，Markdown 链接就直接出现在草稿里，回车发出去，agent 就能读那张表/文档。

## 使用

1. 输入框左侧出现「＋ 引用」按钮（紧挨系统「＋」）；
2. 点击 → 弹面板；
3. 留空看最近 30 天编辑的文档，或输入关键词搜索；
4. ↑/↓ 选择，回车插入（也可以鼠标点）；
5. 插入的是 `[标题](URL)` 文本，可撤销、可编辑，不会自动发送。

## 数据来源（只读）

- 复用本机已认证的 `lark-cli`（用户身份）；
- 命令：`lark-cli drive +search --query <关键词> --sort edit_time --doc-types docx,bitable,sheet,wiki,slides`；
- 只读搜索，不写入、不修改飞书内容。

## 安装

前置：DSH 桌面端 + 本机已登录 `lark-cli`（`lark-cli auth status` 显示 user ready）。

```bash
dsh plugin --profile <profile> add @lyra_wang/dsh-feishu-ref
```

装完重启 DSH；输入框左侧即出现「＋ 引用」。

## 边界

- 只插入链接文本，不上传附件、不改文档权限；
- 搜索失败时面板内显示真实错误（常见：`lark-cli` 未登录 / 网络）；
- 不访问网络外发任何数据，所有请求都发往本机 DSH 的同源路由。
