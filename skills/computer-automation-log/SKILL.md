---
name: computer-automation-log
description: 用操作者的真实电脑或浏览器做 Computer Use / Browser Use（截屏、点击、输入、滚动、AX / CGEvent / AppleScript、Chrome DevTools MCP、Playwright MCP、CDP）时使用。操作前先查 orchestrations/computer-automation/manuals/ 里已有的文档并复用，操作后按同一套约定生成或更新文档。当任务需要「像人一样操作界面」、复用操作者登录态、或把一次 GUI / MCP 操作沉淀成别人能照着做的步骤时使用；不要用于纯 CLI / API 就能完成的任务，也不要写没有实际执行过的操作。
compatibility: "需要 bash 与 python3；需要一份 ai-capability-store 检出（文档写入它的 orchestrations/computer-automation/manuals/）；浏览器 / 桌面工具由宿主提供（Chrome DevTools MCP、Playwright MCP、screencapture、AX / CGEvent、AppleScript 等），本 skill 不携带任何工具，也不需要任何 MCP。"
---

# Computer Automation Log · 电脑操作文档

> 定位：`orchestrations/computer-automation/manuals/` 文档区的**唯一写入口**。文档规则由
> `orchestrations/computer-automation/manuals/README.md` 定义，本 skill 只负责执行它 —— 规则改在那里，不在这里。

## 触发条件

- 你即将或已经用 GUI / 浏览器驱动操作者的机器：点击、输入、滚动、截屏、读 AX 树、CDP 或 MCP 控制页面。
- 用户说「用我的电脑 / 帮我操作一下浏览器 / 复现这个页面操作」。
- 反例：纯 CLI / API 能完成的任务不触发；只读网页用 `web_fetch` 不算 Browser Use。

## 四步

1. **LOCATE** — 定位 Store
   顺序：`--store` 参数 > `$AI_CAPABILITY_STORE` > 由脚本自身路径反推
   （`skills/computer-automation-log/scripts/` → 仓库根）。
   找不到 `orchestrations/computer-automation/manuals/` 就**停**，问人，不要猜路径。

2. **REUSE**（操作前）— 查已有文档
   读对应子目录的索引表。命中同一主题（同一工具 / 同一站点 / 同一 App）就照它做：
   **先复用再创新**。已有文档的做法失效时，操作完把它改对，而不是另开一篇。

3. **RECORD**（操作后）— 写文档
   - 新主题：`python3 scripts/new_doc.py --kind browser|computer --slug <kebab-case> --title "<标题>"`
   - 老主题：直接编辑已有文件，补「已知坑 / 何时别用」，不要开第二篇。
   - 只写**实际执行过、亲眼看到结果**的步骤；没跑通的写成「未验证 + 卡在哪」。

4. **GATE** — 校验
   `python3 scripts/check_doc.py <doc.md>` 必须 exit 0 才算完成。
   FAIL 就按报错改文档，不要绕过检查，也不要改脚本放水。

## 记什么 / 不记什么

| 记 | 不记 |
|---|---|
| 入口（MCP / CLI / CDP）、权限前提 | token、cookie、密码、账号、Bearer |
| 用谁的会话（独立实例 / 操作者已登录 Chrome） | 带 query 的完整 URL（只留域名 + 路径） |
| 怎么证明生效，以及证据种类 | 页面正文、聊天记录、个人信息 |
| 何时别用、已知坑 | 本机绝对路径（`~/`、`/Users/`、`file://`） |
| 已验证 / 未验证 的边界 | 没实测却写成事实的结论 |

## 停手等批准

- 要把操作者的真实账号数据写进文档 → **停**。
- 要记录站点 URL → 只留 `https://<域名>/<路径>`，query 一律删。
- 这个仓库是公开的（`LyraWang6688/ai-capability-store`）：默认文档会被所有人看到。

## 脚本

| 脚本 | 作用 | 退出码 |
|---|---|---|
| `scripts/new_doc.py` | 按约定生成骨架 + 自动补索引表 | 0 成功 / 1 环境错 / 2 目标已存在 |
| `scripts/check_doc.py` | 门禁：抬头、必答小节、凭据、绝对路径、索引行 | 0 通过 / 1 不通过 |
| `scripts/test_scripts.py` | 离线自测（临时目录，不碰真实文档） | 0 全绿 / 1 有失败 |

## 必答小节

两类文档的必答问题、合格范例与反例见
[references/doc-contract.md](references/doc-contract.md)。正文写得再长，缺一个必答小节也不合格。

## 写入范围

只写 `orchestrations/computer-automation/manuals/browser-use/*.md`、`orchestrations/computer-automation/manuals/computer-use/*.md`，
以及这两个目录 `README.md` 的索引表。**不改其他任何文件**：不碰 `registry.yaml`、
不改 shelf README 的规则段、不动 `skills/` 下的其他资产。

## 依赖状态

浏览器 / 桌面工具都**没有**登记为 External Capability（Chrome DevTools MCP、Playwright MCP
是宿主侧第三方 MCP；`screencapture` / AX / CGEvent 是系统工具）。因此
`dependencies/capability-map.yaml` 未声明依赖 —— 与 `repo-collector` 的处理一致，
不制造虚假依赖记录。

## 本版本范围

v0.1.0 只覆盖「一次真实操作 → 一篇合规文档」这条链路，以 `scripts/test_scripts.py`
的离线测试作为确定性证据；触发率、端到端轨迹、效率指标**未评估**。
文档规则（收什么、怎么命名、何时升级成 Skill）见 `orchestrations/computer-automation/manuals/README.md`。
