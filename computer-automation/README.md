# computer-automation/ — 电脑自动化文档区

> **这不是第五个资产域。** 这里不登记 `registry.yaml`，不参与 Store 的资产口径，
> 只收「怎么操作浏览器 / 怎么操作电脑」的知识文档。可复用的流程成熟后，再升级成
> `skills/` 里的 Skill（见文末）。

## 为什么收这些（先读这段）

**读者不是人，是下一个要重做同一件事的 Agent。**

它没有我们这次会话的记忆，也不会去猜。所以要让它少走弯路，一篇文档必须给出三样东西：

| # | 给什么 | 长什么样 |
|---|---|---|
| 1 | **走通的、可复现的步骤** | 用什么工具、按什么顺序、每步之后该看到什么 |
| 2 | **没走通的经验教训** | 症状 → 原因 → 修法；真踩过的才算 |
| 3 | **用了哪些工具** | 工具 / 类型 / 用来做什么 / 前置条件，一张表看完 |

只有结论（"这个 App 支持 X、不支持 Y"）的文档**只完成了一半**：它能防止错误判断，
但下一个 Agent 仍然要从零摸索怎么动手。

对应到每篇文档，就是这三个必答小节：
`## 工具清单` · `## 可复现步骤` · `## 踩坑实录`（再加 `## 权限前提` 与 `## 何时别用` 两个护栏）。
门禁 `check_doc.py` 会拦，缺一个不算交付。

**一篇控制在五节以内。** 小节数量本身就是阅读成本：选这条路的理由写进「可复现步骤」第 1 步，
每步的观察点就是验证，最后一步就是收尾——不要再单独开 `操作手段` / `如何验证` / `回退`。

## 收什么

| 子目录 | 收什么 |
|---|---|
| `browser-use/` | 浏览器操作：CDP / Chrome DevTools MCP / Playwright MCP、登录态复用、页面结构读取、站点交互套路 |
| `computer-use/` | 桌面操作：截屏、AX（辅助功能树）、鼠标键盘模拟、权限授予、原生 / Electron App 差异 |

不收：

- 某个任务的具体 SOP → `skills/`
- 可调用的工具实现 → `external-capabilities/`
- 外部依赖的已知 bug → `docs/known-issues/`

## 目录结构

```text
computer-automation/
├── README.md              # 本文件：范围与约定
├── browser-use/
│   ├── README.md          # 索引 + 每篇文档的必备字段
│   └── <topic>.md         # 待填充
└── computer-use/
    ├── README.md
    ├── <topic>.md            # 不属于任何 App 的通用主题
    └── <app>/                # 一个软件一个文件夹
        ├── README.md         # 索引：已写的功能 + 待建的功能
        └── <功能>.md         # 这个软件的一项功能
```

## 文档约定（填充者照此写）

0. **三样东西缺一不可**：可复现步骤、踩坑实录、工具清单（见上面「为什么收这些」）。
1. **一篇一件事**，文件名 kebab-case，例如 `chrome-devtools-mcp.md`。
1.1 **文件夹 = 一个软件，里面按功能各一篇**：`<app>/README.md` 做索引，
   `<app>/<功能>.md` 是这个软件的一项功能。同一个软件的功能会持续增加，所以用文件夹收录。
   还没实测的功能不要建空文档，在 README 的「待建功能」表里列出即可。
   只有不属于任何 App 的通用主题（`ax-tree.md`、`cgevent-input.md`）才单篇放本层。
1.2 **文件名就是检索键**：Agent 靠文件名决定要不要读。用 `cdp-takeover` / `window-capture` /
   `ax-tree` 这种能命中任务的词，不要 `basic-operation` / `misc` / `notes`。
2. 每篇开头四行抬头：`环境` / `实测日期` / `验证方式` / `结论`。
3. **区分「已验证」与「听说」**：没实测的标 `未验证`，不要写成事实。
4. 不写凭据（token / cookie / 账号）；引用外部资料只给链接 + 结论，不整段复制。
5. 互相用相对路径链接，不写本机绝对路径（`~/Documents/...` 不进仓库）。

## 怎么生成（唯一入口）

格式不要手写，走 Skill [`skills/computer-automation-log`](../skills/computer-automation-log/SKILL.md)：

```bash
# 新主题：生成骨架并登记索引
python3 skills/computer-automation-log/scripts/new_doc.py \
  --kind browser --slug chrome-devtools-mcp --title "Chrome DevTools MCP 连接操作者自己的 Chrome"

# 写完过门禁（exit 0 才算完成）
python3 skills/computer-automation-log/scripts/check_doc.py \
  computer-automation/browser-use/chrome-devtools-mcp.md
```

必答问题与合格范例见
[`skills/computer-automation-log/references/doc-contract.md`](../skills/computer-automation-log/references/doc-contract.md)。
手写也可以，但同样要过 `check_doc.py` —— 格式不合格的文档不算交付。

## 何时升级成 Skill

三条同时成立才值得升：

- 同一套步骤被重复用到 ≥ 2 次；
- 能写成「判断 → 动作」的确定性流程，不依赖某次会话的上下文；
- 有可验证的产出或证据。

升级时按 `SKILL-FORMAT.md` 在 `skills/<name>/` 建 Skill，本目录对应文档缩成一个链接。
