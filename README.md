# wechat-draft-mcp

本地 MCP 服务：把一个磁盘上的文章文件夹，创建或**原地更新**微信公众号草稿。

**默认只创建草稿，不发布、不群发、不改动公众号任何设置。**
0.3.0 起按需开放三类破坏性操作（更新草稿 / 删除草稿 / 删除永久素材 / 删除已发布文章），
**默认全部关闭**：需要宿主显式设置 `WECHAT_ALLOW_DESTRUCTIVE=1`，且每条删除都要二次确认（目标 ID 后 6 位），
执行前自动备份到本地、执行后写入审计日志。

## 这是什么

一个自包含的 MCP server，供成熟 AI Host（豆包工作、WorkBuddy 等）通过 stdio 调用。
用户在对话里说「把这篇文章传到公众号草稿箱」，Host 就会调用本服务完成上传。

## 设计原则

| 原则 | 说明 |
|---|---|
| **传引用，不传正文** | 工具参数只有一个绝对路径。正文与图片从磁盘读取，不经过模型上下文，token 消耗与文章长度无关 |
| **先记账，再动手** | 第一次微信副作用之前必须先落盘 `creating`。此后任何异常都属于「结果未知」，禁止自动重试 |
| **内容指纹幂等** | 同一账号 + 同一内容重复调用返回既有草稿，不会重复创建 |
| **凭证不出本机** | AppID/AppSecret 由 Host 注入环境变量；本服务不读 `.env`、不持久化密钥、不把密钥返回给模型 |
| **只创建草稿（默认）** | 正式发布始终由用户在公众号后台人工完成 |
| **破坏性操作四道门** | ① `WECHAT_ALLOW_DESTRUCTIVE=1`（默认关）② `confirm` = 目标 ID 后 6 位 ③ 先备份到 `state/backups/` ④ 写入 `state/audit.jsonl` |
| **更新保留线上字段** | `draft/update` 只替换正文；标题、作者、摘要、封面及其裁切信息、评论设置一律原样回传 |

## 工具

| 工具 | 作用 | 副作用 |
|---|---|---|
| `wechat_draft_status` | 检查凭证、IP 白名单、草稿箱权限 | 无 |
| `inspect_wechat_article` | 预检文章文件夹 | 无 |
| `upload_wechat_draft` | 创建公众号草稿 | 有（仅草稿） |
| `get_wechat_draft` | 按 media_id 读回草稿 | 无 |
| `get_wechat_audit` | 查看更新/删除的审计记录（含失败原因与备份路径） | 无 |
| `update_wechat_draft` | **原地更新**已有草稿的正文（可 `dry_run` 演练） | 有（覆盖正文，改前自动备份） |
| `delete_wechat_draft` | 删除草稿（不可逆） | ⚠️ 破坏性，需开关 + 确认 |
| `delete_wechat_material` | 删除永久素材（如封面图） | ⚠️ 破坏性，需开关 + 确认 |
| `delete_wechat_published` | 删除**已发布**文章（最高危） | ⚠️ 需开关 + 确认 + `i_understand_published_deletion=true` |

## 文章文件夹结构

```text
我的文章/
├── article.html       正文（必需；也支持 content.html）
├── metadata.json      标题/作者/摘要（可选；也支持 meta.json）
├── cover.png          封面（必需；也支持 cover.jpg / 封面.* / assets.json 指定）
└── images/            正文插图（可选，用相对路径引用）
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECHAT_APP_ID` | 是 | 公众号 AppID（由 Host 注入） |
| `WECHAT_APP_SECRET` | 是 | 公众号 AppSecret（由 Host 注入） |
| `WECHAT_DEFAULT_AUTHOR` | 否 | 未指定作者时的兜底值 |
| `WECHAT_DRAFT_STATE_DIR` | 否 | 幂等账本目录，默认 `~/.wechat-draft-capability/state` |
| `WECHAT_DRAFT_ALLOWED_ROOTS` | 否 | 允许读取的文章根目录，逗号分隔 |

## 通过 npx 运行（MCP 生态通用形态）

已按 npm 生态的要求打包：`bin` 指向编译产物，`dist/` 随包发布，`prepare` 保证发布前自动构建。

```bash
WECHAT_APP_ID=xxx WECHAT_APP_SECRET=xxx npx -y wechat-draft-mcp@0.2.0
```

宿主（豆包工作 / WorkBuddy / 其他 MCP 客户端）里的 stdio 配置：

```jsonc
{
  "mcpServers": {
    "wechat-draft": {
      "command": "npx",
      "args": ["-y", "wechat-draft-mcp@0.2.0"],
      "env": { "WECHAT_APP_ID": "...", "WECHAT_APP_SECRET": "..." }
    }
  }
}
```

发布前自检（不发布）：

```bash
npm run check:pack    # typecheck + 测试 + npm pack --dry-run（打印将要发布的文件清单）
```

包内只有 `dist/`、`skills/`、`README.md`、`LICENSE`（测试、HANDOFF、调研产物都不进包）。

## 命令

```bash
npm install
npm run build

# MCP 服务（由 Host 启动）
node dist/mcpServer.js

# 命令行诊断
node --env-file=.env dist/cli.js doctor
node --env-file=.env dist/cli.js inspect "/绝对路径/文章目录"
node --env-file=.env dist/cli.js upload  "/绝对路径/文章目录"
node --env-file=.env dist/cli.js update  "/绝对路径/文章目录" --media-id <草稿ID> [--with-meta] [--with-cover] [--dry-run]
node --env-file=.env dist/cli.js show <草稿ID>          # 读回一条草稿，打印它现在的样子
node --env-file=.env dist/cli.js audit --limit 20
```

## 测试

```bash
npm test          # 编译 src+tests 到 dist-test/，跑 112 项测试（约 3 秒）
npm run test:only # 跳过编译，直接重跑
```

零额外依赖（node 内置 test runner），不联网、不碰真实公众号：mock 微信服务器是
本地 HTTP 服务，覆盖文章包解析、内容指纹幂等、`creating` 状态锁定、路径沙箱、
错误码分类、MCP stdio 通道的 **stdout 纯净性**，以及**完整上传链路**（子进程 + JSON-RPC +
真上传，请求经测试侧 fetch 拦截器改送到本地 mock —— 产品代码不提供改接口地址的开关）。

## 边界

- 不做 Markdown → HTML 转换。正文排版由创作侧负责。
- 不支持 `data:` URI 图片（微信素材接口不接受 base64）。
- 正文图片只支持 jpg/png 且单张 <1MB；封面走永久素材。
- 正文必须少于 20000 字符。
