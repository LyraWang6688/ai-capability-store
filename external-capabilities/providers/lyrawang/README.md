# Provider: lyrawang

王颖（LyraWang）自研并自托管的能力 —— 其底层服务（分析引擎、报告服务器）由本人自建并提供。

## 概览

| 项 | 说明 |
|---|---|
| Provider 标识 | `lyrawang` |
| 平台 | 无（自研自托管：底层服务由本人自建，不存在第三方平台） |
| 官方开放接口 | 不适用 |
| 官方 CLI | 不适用 |
| 本 Store 下的能力 | [`teaming-mcp`](../../mcp/teaming-mcp/) · [`selection-toolbar`](../../plugin/selection-toolbar/) · [`dsh-feishu-remote`](../../cli/dsh-feishu-remote/) · [`ai-quote-clip`](../../cli/ai-quote-clip/) · [`command-sync`](../../cli/command-sync/) |

## 为什么自研能力挂 lyrawang

按 [`external-capabilities/README.md`](../../README.md) 的 **Provider Semantics**，
`provider` 记的是**提供底层服务、从而划定能力边界的那一方**。

本 Store 里另两个能力挂平台（`feishu` / `wechat`），因为它们本质是"某平台 API 的
受控封装"—— 平台的接口、配额与权限模型决定了它们能做什么。

自研能力不同：它的边界由**我们自己的设计**决定。`teaming-mcp` 就同时用到飞书、
大模型服务、以及自建的 teaming-bot 服务器，挂在任一平台名下都会误导使用者 ——
它并不是"飞书的能力"。

**判据**：这个能力能做什么，是被谁的规则划死的？

```
被第三方 API 划死        → 那个平台（feishu / wechat）
由我们自己的设计决定      → lyrawang
```

（`provider` **不是**维护方字段：本 Store 只收 Store-managed 能力，
维护方恒为本人，那样的字段没有信息量。）

`selection-toolbar` 同理：它做的事（划选文字后浮出工具条、把注释追加到飞书文档）是我们自己设计的
产品形态；飞书只是它调用的下游（经操作者本机的 `lark-cli` 授权），并不是"飞书提供的选区工具条"。
如果按飞书归类，会让人误以为这是飞书自带的能力。

## 认证模型（仅元数据）

各能力的认证模型不同，以其注册表条目为准。共性：

- **不在此仓库保存任何凭据值** —— 见 [SECURITY.md](../../SECURITY.md)。
- 自研能力通常需要**一个自建服务**或**一个用户侧凭证**，注册表里只写
  "需要什么"，不写"值是什么"。

`teaming-mcp` 的具体形态见其注册表条目的 `auth` 字段。它有一个值得单独说明的设计：

### `teaming-mcp` 为什么不由自己调用飞书

```text
宿主（豆包工作 / WorkBuddy）用自己的飞书能力取逐字稿
        ↓ 把逐字稿交给 MCP
teaming-mcp 只做分析，不接触飞书
        ↓ 报告上传 teaming-bot 服务器换网页报告页
```

**起因是一次实测**：豆包账号（通过豆包登录飞书的那类账号）在飞书侧既不能创建应用、
也不能授权已有应用，两条路都被拒（`21001` / "你没有该应用的使用权限"）。
但**宿主自带的飞书能力对它是通的** —— 豆包工作实测用它自己的内部应用，
返回 `ok:true`、`identity:user`。

于是把「取数」交给宿主，「分析」留给 MCP，MCP 就完全不需要飞书授权了。
这也是 `teaming-mcp` 与另两个能力最本质的区别：**它的瓶颈不在平台权限，
而在"谁去取数"这个分工。**

## 已知约束

| 约束 | 说明 |
|---|---|
| 自研资产的可用性**不保证** | 与平台封装型不同，自研能力可能依赖我们自己的服务器与发布流程；`status` 会如实反映前置条件 |
| 版本由 Store 注册表记录 | 见 `VERSIONING.md`；不在 `SKILL.md` 里写 `version` |

## 参考

- 本 Store 的外部能力域说明：[`external-capabilities/README.md`](../../README.md)
