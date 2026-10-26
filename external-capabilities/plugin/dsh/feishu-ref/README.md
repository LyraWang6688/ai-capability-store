# feishu-ref

**在 DSH 输入框点「＋ 引用」，搜索你的飞书群聊 / 文档 / 多维表格，选中后把链接插入输入框。**

不需要切换飞书 App、不需要复制粘贴 URL：选中一条，Markdown 链接就直接出现在草稿里，
回车发出去，agent 就能顺着链接读那个群、那张表或那篇文档。

> 能力边界（0.5.0）：只做「搜索飞书群聊 / 文档 → 链接插入输入框」，并展示「最近使用」3 条。
> **不包含**自动在右侧浏览器打开文档（该能力依赖第三方插件拿不到的 sidebarRight 服务，已移除）。

## 使用

1. 输入框左侧出现「＋ 引用」按钮（紧挨系统「＋」）；
2. 点击 → 弹面板；
3. 面板顶部固定显示「最近使用」的 3 条；留空只列最近编辑的文档，
   输入关键词则**群聊结果排在文档前面**（搜群时说「你看下这个群」就行）；
4. ↑/↓ 选择，回车插入（也可以鼠标点）；
5. 插入的是 `[标题](URL)` 文本，可撤销、可编辑，不会自动发送。

## 数据来源（只读）

- 复用本机已认证的 `lark-cli`（用户身份），两条搜索并行发出，一条失败不影响另一条：
  - 文档：`lark-cli drive +search --query <关键词> --sort edit_time --doc-types docx,bitable,sheet,wiki,slides`
  - 群聊：`lark-cli im +chat-search --query <关键词> --search-types private,external,public_joined`
    （群搜索**必须有关键词**，所以留空时没有「群聊」分组）
- 群链接用飞书 AppLink：`https://applink.feishu.cn/client/chat/open?openChatId=<chat_id>`。
  链接里带的是稳定的 `chat_id`，agent 拿到后可直接 `lark-cli im +chat-messages-list --chat-id <chat_id>` 读群消息。
- 不用 `lark-cli im chats link`：那条命令返回的是 `add_by_link` **拉人入群**的邀请链接，还会过期，不是「打开群」。
- 只读搜索，不写入、不修改飞书内容。

## 安装

前置：DSH 桌面端 + 本机已登录 `lark-cli`（`lark-cli auth status` 显示 user ready）。

```bash
dsh plugin --profile <profile> add @lyra_wang/dsh-feishu-ref
```

装完重启 DSH；输入框左侧即出现「＋ 引用」。

## 边界

- 只插入链接文本，不上传附件、不改文档权限；
- 群聊只列「已加入 / 外部 / 已加入的公开群」，未加入的公开群不出现——不是你的群，引用它没有意义；
- 搜索失败时面板内显示真实错误（常见：`lark-cli` 未登录 / 网络）；文档与群聊其中一条失败会显示「搜索不完整」，
  另一条结果照常可用；
- 不访问网络外发任何数据，所有请求都发往本机 DSH 的同源路由。

## 版本记录

### 0.5.0：搜群聊

- 同一面板新增「群聊」分组：输入关键词并行搜文档与群聊，群聊排在前面；
- 群条目显示群名 + 描述（没有描述的外部群显示「外部群」）；
- 插入 `[群名](applink)`，`openChatId` 即 `chat_id`，agent 可据此读群消息；
- 群搜索失败不拖垮文档搜索（两条 `lark-cli` 调用并行 + 分别兜底）。

### 0.2.0：记住最近使用

- 每次选择后写入浏览器 `localStorage`（键 `@lyra_wang/dsh-feishu-ref:recent`，保留 8 条）；
- 面板打开时顶部显示最近 3 条，和搜索结果分组、不重复；
- 只保存在本机浏览器里，不上传、不进仓库。
