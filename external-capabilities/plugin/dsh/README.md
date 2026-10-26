# DSH 插件开发：我们验证过的 API 与边界

> 这份文档只写**我们自己动手验证过**的东西（成功和失败都写），
> 目的是让下一个人不用再把同样的坑踩一遍。
>
> 适用对象：第三方 DSH 插件作者（不是 DSH 官方包开发者）。
> 验证版本：DSH Desktop `0.2.1-rc.2`（2026-10，macOS arm64）。
> AP 可能随版本变化；引用具体行为时请以你当前版本的运行结果为准。

---

## 〇、结论速览：已跑通 / 未跑通

### ✅ 已跑通（在生产里用着）

| 能力 | 落在哪个插件 | 备注 |
|---|---|---|
| 输入框左侧加按钮 | feishu-ref / image-ocr / inbox | `conversation.input.left` |
| 自绘面板 / 弹窗 / 划词工具条 | 四个插件都用 | `shell.overlay` + `position:fixed` |
| 往草稿插入文本（可撤销） | feishu-ref / image-ocr | `inputActions.captureInsertion()` + `insertText()` |
| 划词取选区 → 工具条动作 | selection-toolbar | `window.getSelection()` |
| Host 自定义路由 + 连接鉴权 | 四个插件的 Host 半 | `ctx.webServer.register` + `requestRejection` |
| 调本机 CLI（lark-cli 等） | feishu-ref / image-ocr / inbox | `ctx.subprocess.spawn` |
| 读写飞书多维表格 | inbox | `/plugins/inbox/list|read|deliver` |
| 面板轮询（30 分钟） | inbox | 客户端 `setInterval` |
| **点对话里的链接 → 右侧栏打开该 URL** | 宿主自带（`linkOpening: sidebar`）| 设置项即可，不需要插件 |
| **侧边栏会被打开**（程序化） | feishu-ref 0.3.9 验证过 | 见下方"未跑通"的边界 |

### ❌ 未跑通（明确记录，别再重复踩）

| 想做的事 | 现状 | 证据 |
|---|---|---|
| **插件主动打开右侧栏 + 把 URL 填进地址栏** | 侧栏能被打开，但 **URL 不会自动填充**；地址栏仍是空白/旧页面 | 0.3.9 拿到服务后侧栏展开；0.4.0 诊断显示 `openTab` 调用后无导航、控制台无报错；根因是第三方拿不到 `sidebarRight`（第四节）|
| 第三方获取 `ctx.sidebarRight` | 4 种方式全失败（`ctx.get` / `inject` / `reflect.get` / `dsh.client.inject`），最后一种会让 App 启动失败 | 第四节表格 |
| 往 `conversation.input.dock` 塞引用条 | 注册成功但长期 `active:false`，界面不渲染 | 第三节 3.1 |
| 富文本多行插入 | 换行被吞，`> a\n> b` 会变成一行 | 第三节 3.2 |
| **没有"发送前"钩子** | 引用/改写只能在发送前 hack 写入草稿：捕获阶段监听 Enter 与发送按钮（依赖 DOM 结构，覆盖不全）| 上游 [feature request #10791](https://github.com/deepseek-ai/deepseek-harness/discussions/10791) |
| **读右侧「浏览器 tab」里的网页内容** | 结构上不可能：那是 iframe / `<webview>` 独立浏览上下文，父页面既 `querySelectorAll` 不进去、也收不到里面的 `selectionchange` | 第四节 4.2（含 0.4.0 诊断实测：全页面只命中左栏会话列表）|

> 跟踪 issue：[feishu-ref：自动在右侧浏览器打开引用文档（阻塞中）](https://github.com/LyraWang6688/ai-capability-store/issues/268)
> 上游：[feature request #10592](https://github.com/deepseek-ai/deepseek-harness/discussions/10592)

**当前可行的替代**：链接由 agent 写在回复里，靠宿主 `linkOpening: sidebar` 在右侧栏打开——不需要插件，但需要用户点链接。

---

## 一、一个 DSH 插件由什么组成

```
<plugin>/
├── package.json        名字、版本、exports、dsh 声明
├── cordis.patch.yml    往 profile 里插入自己这一行
├── index.js            Host 半：路由 / 后台逻辑（Node）
└── client.js           Client 半：往 Web UI 插 UI（浏览器，React）
```

`package.json` 里两组关键声明：

```jsonc
{
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-layout"] }
  }
}
```

| 字段 | 含义 | 经验 |
|---|---|---|
| `dsh.client.inject` | 声明**客户端模块**依赖（package id） | ⚠️ 只能填**通过 profile 安装的插件包**或官方已随 web bundle 发出的模块；填了不存在的模块会让整个 App 启动失败（我们踩过，见第四节）|
| `dsh.client.platform` | 固定 `"web"` | — |
| `dsh.client.immediately` | 是否随页面启动预取 | 一般 `true` |
| `dsh.bundle.patch` | 该插件往 profile 注入的行 | 见下 |

`cordis.patch.yml` 的形状（**不要**给没声明 Config schema 的插件传 `config`）：

```yaml
- insert:
    - id: my-plugin
      name: "@scope/my-plugin"
```

---

## 二、Host 半：我们验证可用的接口

```js
export const inject = ['webServer', 'subprocess'];
export function apply(ctx) { /* ... */ }
```

| 能力 | 用法 | 出处 |
|---|---|---|
| 注册 HTTP 路由 | `ctx.webServer.register({ kind: 'exact', path: '/plugins/x/y', handler })` | `feishu-ref` / `image-ocr` / `dsh-inbox` |
| 路由鉴权 | `ctx.get('connection').requestRejection({ headers: req.headers })` | 同上（不通过时返回 401/403，直接回给浏览器）|
| 跑子进程 | `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs })` | `feishu-ref` 跑 `lark-cli` |
| 生命周期 | `ctx.effect(() => register(), 'label')` | 所有插件 |
| 日志 | `ctx.logger?.warn?.(...)` | 所有插件 |

> 路由默认跑在桌面内置 web server 上，路径统一 `/plugins/<plugin>/<action>`；
> 浏览器侧同源 `fetch('/plugins/...')` 即可，会自动带上签名 cookie。

---

## 三、Client 半：我们验证可用的接口

```js
window.__ModuleLoader__.load({
  id: '@scope/my-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'my-button',
          order: 4,
        }, (props) => h(MyButton, props)));
      },
    };
  },
});
```

### 3.1 我们实际用过的 Slot

| Slot | 位置 | 用途 | 状态 |
|---|---|---|---|
| `conversation.input.left` | 输入框左侧工具行 | 加按钮（＋引用 / ＋识图 / 📥收件箱）| ✅ 稳定 |
| `shell.overlay` | 全屏浮层 | 弹窗面板、引用条、提示 | ✅ 稳定（必须自己 `position:fixed`）|
| `conversation.input.dock` | 输入框上方全宽条 | 想放"引用条" | ⚠️ 注册后长期 `active:false`（不渲染），我们最终**放弃**，改用 `shell.overlay` |
| `sidebar.panellist` / `sidebar.footer.action` | 侧栏图标/底部操作 | 未使用 | 文档存在，未验证 |
| **`conversation.chat.node`** | 消息节点 | 想"在消息里渲染自定义内容" | ⚠️ **已验证，结论是"此路不通"**：它是 **keyed slot**，按节点类型整体替换，**没有"消息内插槽"**。见 [3.4](#34-conversationchatnode-是-keyed-slot消息内没有插槽2026-10-24-源码确认) |

### 3.2 Slot 传入的 props（`conversation.input.left` 实测）

`inputActions` 是我们最常用的：

| 方法 | 作用 | 备注 |
|---|---|---|
| `captureInsertion()` | 记录当前光标位置 | 与 `insertText` 配对使用，插入可撤销 |
| `insertText(text, span)` | 往草稿插入文本 | **富文本编辑器会把换行吃掉**：多行内容会粘成一行 |
| `setDraft(text)` | 整体替换草稿 | 慎用，会覆盖用户输入 |
| `submit()` | 触发发送 | 可用于自定义发送按钮 |
| `addAttachments(ids)` / `removeAttachment(id)` | 附件 | 需要先拿到附件 id（上传服务），未深入验证 |

其他可用 props：`sessionId`、`useInput`、`useSession`、`useChat`、`useTrajectory`、`useAccess` 等（都是 hook / 选择器，来自 slot 标准 props）。

### 3.3 样式与主题

用 CSS 变量继承宿主主题，例如：

```css
color: var(--dsw-alias-label-primary, #e6e6e9);
background: var(--dsw-alias-bg-layer-2, #26262b);
border: 1px solid var(--dsw-alias-border-l1, #3a3a40);
```

> 不要替换 `document.body`、不要读别的插件的 DOM/样式。样式以 `<style>` 元素随组件渲染，卸载即移除。

### 3.4 `conversation.chat.node` 是 keyed slot，消息内没有插槽（2026-10-24 源码确认）

> 来源：解包 `app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`，
> DSH Desktop `0.2.1-rc.2`。走的是 §7 自查顺序里"读实现（行为问题最快）"那条路，
> 比重建探针快，而且不碰运行环境。

**注册形状**（官方自己的写法）：

```js
ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
  name: "conversation.chat.node",
  key: "assistant-step",        // ← 节点类型，不是消息实例
  locale: NS,
  children: {
    "conversation.chat.reasoning.body": { kind: "single", scope: "session" },
    "conversation.chat.message.images": { kind: "single", scope: "session" },
  },
  inject: () => ({ hooks: { presentation } }),
}, AssistantNodeView));
```

**`key` 的全部取值（15 个，即它能替换的节点种类）**：

`user` · `steering` · `assistant-step` · `turn-process` · `turn-tail` · `turn-trigger` ·
`turn-error` · `turn-max-tokens` · `model-retry` · `command` · `compaction` ·
`manual-compaction` · `system-prompt` · `context` · `unknown`

**为什么它不能用来"在回复里插一张卡片"**：

| 想做的事 | 能不能 |
|---|---|
| 按节点类型整体换掉渲染器 | ✅ 可以（`key` 选类型，传自己的组件） |
| 在**某一条**消息里插入自定义内容 | ❌ 不行——`key` 是类型不是实例，没有 per-message 钩子 |
| 在 assistant 正文的 Markdown 里插入自定义块 | ❌ 不行——`AssistantMarkdown({ blocks, ... })` 是固定组件，没有 components / renderer 注册表 |
| 往 assistant 节点内部插东西 | ⚠️ **只有两个子槽**：`conversation.chat.reasoning.body`（思考正文）与 `conversation.chat.message.images`（图片） |

**结论**：想在 assistant 文本中间插一个自定义渲染块，当前版本**没有正门**。
唯一的"正门级"做法是把 `assistant-step` 整个换掉——那意味着重新实现整套 Markdown 渲染，
不现实。**所以"在旁边渲染、观察 DOM"不是等一个更好槽位的临时通道，而是当前版本唯一可行的实现方式。**

**顺带确认的**：`conversation.chat.flow` 只添加一个 `display:contents` 的 DOM 锚点，
供行选择器使用，不承载内容，也不能当插槽用。

### 3.5 这次调查的方法（下次可以直接复用）

`app.asar` 的 `node_modules` 里是**完整包**（含 `lib/client.js`），可以直接读实现，
比"写探针 + 装 profile + 重启"快得多，而且不动运行环境。

```text
asar 头部：u32@4 = headerSize，u32@12 = JSON 长度，数据区起点 = 8 + headerSize
找 slot 契约：grep -A 4 'slots.register({' <pkg>/lib/client.js
找 slot 名全量：grep -o 'data-slot="conversation\.[a-zA-Z.]*"' <pkg>/lib/client.js
```

⚠️ 一个假线索：整包搜索 `markdownRenderer` 会命中
`dsh-experimental-inspector/lib/devtools/chunks/*.js`——那是 inspector 里打包的第三方
Markdown 库，**不是** DSH 的扩展点。

-----

## 四、明确不可用 / 会出事的写法

### 4.1 第三方插件拿不到 `ctx.sidebarRight`

社区与我们都验证过：**`sidebarRight` 服务对第三方 Client 插件不可得**。

| 尝试 | 结果 |
|---|---|
| `ctx.get('sidebarRight')` | `undefined` |
| `ctx.inject(['sidebarRight'], cb)` | 回调永不触发（该服务由 `ctx.reflect.provide` 提供，不是普通 Cordis service）|
| `ctx.reflect.get('sidebarRight', false)` | `undefined` |
| `dsh.client.inject` 里声明 `@deepseek-ai/dsh-client-ui-sidebar-right` | ❌ **App 启动失败**：`web boot: 1 entry did not activate` |

社区佐证：

- [`anne43983959/dsh-jobs-autoclose`](https://github.com/anne43983959/dsh-jobs-autoclose)：`0.1.7-rc.2` 起 `ctx.get("sidebarRight")` 拿不到，插件选择 fail-closed
- [`Lanzgale/dsh-rightbar-shell`](https://github.com/Lanzgale/dsh-rightbar-shell)：只能靠"替换官方包名"提供替身服务（会替换官方 UI 包，不推荐）

上游反馈：[Feature request #10592](https://github.com/deepseek-ai/deepseek-harness/discussions/10592)、[Bug #10591](https://github.com/deepseek-ai/deepseek-harness/discussions/10591)

**替代做法**：把链接直接放进回复（Markdown），由宿主 `linkOpening` 设置决定打开位置：

```yaml
- id: ui-chat
  config:
    linkOpening: sidebar   # 点对话里的链接 → 右侧内置浏览器；new-tab = 系统浏览器
```

### 4.2 读不到右侧「浏览器 tab」里的网页内容（结构限制）

右侧浏览器 tab 由官方包 `@deepseek-ai/dsh-client-ui-sidebar-browser` 渲染。
它的 README 写得很明确：

> **Web 使用 iframe** 和应用维护的 history；**Desktop 使用 Electron `<webview>`**、原生导航 history 和保活页面。
> 本包**不会向被访问内容注入 Electron 或 Node 能力**。

于是它和侧边栏终端是两种东西：

| 面板 | 结构 | 父页面能读 DOM / 收选中吗 |
|---|---|---|
| 侧边栏终端 | 同一 document 里的 xterm DOM（`.xterm-rows`） | ✅ 能 |
| 浏览器 tab | iframe（Web）/ `<webview>`（Desktop），**独立浏览上下文** | ❌ `querySelectorAll` 进不去；`selectionchange` 收不到 |

**实测证据（terminal-context 0.4.0 诊断，2026-10-26）**：全页面按
`sidebar` / `rightbar` / `panel` / `terminal` / `browser` 扫容器，只命中 **1 个** —

```json
{ "cls": "PIRFFq_sidebarCol", "chars": 326,
  "sample": "新会话 / 插件 / 自动化任务 / 更多 / 工作区 / workplace / …" }
```

那是**左栏会话列表**（class 名带哈希，`sidebar` 命中而已），浏览器 tab 正文 **0 命中**。

结论：

- **可拿到**：tab 的 **URL 与标题**（面板自己保留，重启还能恢复）
- **拿不到**：正文、选中文字、滚动位置

需要正文时的三条替代路径（按代价排序）：

1. **只把 URL 交给 Agent**，由它自行抓：公开页走 `web_fetch`，需要用户登录态走浏览器 MCP
2. **自建同源代理**（Host 路由取回 HTML 再渲染给 iframe）→ 同源才可能读 DOM；代价是相对链接重写、CSP、登录态
3. **在用户自己的浏览器里用扩展 / userscript** 主动把选中内容推给 Host 路由

> 换句话说：终端那条"读屏幕"的路，在浏览器 tab 上从根上就不成立，不要在 `querySelectorAll` 上加选择器试图修。

### 4.3 其它坑

| 坑 | 现象 | 规避 |
|---|---|---|
| 给无 Config schema 的插件传 `config` | 挂载异常 / 启动报错 | patch 里只写 `id` + `name` |
| `dsh.client.inject` 填官方内置包 | App 启动失败（entry 未激活）| 只填 profile 安装过的包；不确定就不填 |
| 富文本 `insertText` 多行 | 换行被吞成一行 | 插入前把 `\s+` 压成空格 |
| `conversation.input.dock` | 注册成功但 `active:false`，不渲染 | 改用 `shell.overlay` |
| Node < 22 跑 `dsh` CLI | **静默退出**（无输出、exit 0），因为入口用了 `import.meta.main` | 服务器侧用 Node 24+ |
| 刚 `npm publish` 后立刻安装 | 404（registry 尚未 staging 完成，常见几分钟）| 轮询 `.../<pkg>/-/<pkg>-<ver>.tgz` 直到 200 |

---

## 五、我们自己的插件用了哪些 API（索引）

| 插件 | Host 接口 | Client 接口 |
|---|---|---|
| [`feishu-ref`](./feishu-ref/) | `POST /plugins/feishu-ref/search`（调 lark-cli）；连接鉴权 | `conversation.input.left` 按钮 + 自绘面板；`inputActions.insertText` 插入链接 |
| [`image-ocr`](./image-ocr/) | `POST /plugins/image-ocr/ocr`（本地 Vision OCR）| `conversation.input.left` 按钮 + 粘贴面板；`inputActions.insertText` |
| [`selection-toolbar`](./selection-toolbar/) | 收藏/投递/收录/改写/快捷键路由 | `shell.overlay` 划词工具条；`window.getSelection()` 取选区；`document.execCommand('insertText')` 写入草稿 |
| [`inbox`](./inbox/) | `/plugins/inbox/list|read|deliver`（读写飞书 Base）| `conversation.input.left` 按钮 + `shell.overlay` 面板；30 分钟轮询 |

---

## 六、发布与安装（我们踩过的完整流程）

```bash
# 1. 仓库内发版：改版本 → 提交 → PR → 合并 → 打 tag → push
#    版本号必须和 registry 同步，tag 名 <asset>-v<version>
# 2. 发布 npm（需要仓库 owner 本人浏览器授权）
cd external-capabilities/plugin/dsh/<plugin>
npm publish --access public
# 3. 等 registry 可用后安装
dsh plugin --profile desktop add "https://registry.npmjs.org/@scope/<plugin>/-/<plugin>-<version>.tgz"
# 4. 把包名加进 profile 的 dsh.profile.bundles（否则装了不挂载）
# 5. 重启 DSH 生效
```

> Profile 位置：`~/.dsh/profiles/desktop/`（桌面版）。
> `package.json` 的 `dependencies` 决定"装没装"，`dsh.profile.bundles` 决定"开不开"。

---

## 七、接口信息从哪来（自查顺序）

1. **实时检查**（最权威）：`cordis_inspect_list` → `cordis_inspect_query`
   - `Slots.listSubTree(root="conversation.input.left")` 看插槽、owner props、occupants（含 `active`）
   - `Service.listService` / `Config.listConfigs` 查服务与配置 schema
2. **随 App 安装的文档**：`docs/subsystems/*.zh.md`、各包 `README.zh.md`
3. **公开仓库**：`https://github.com/deepseek-ai/deepseek-harness`（`docs/`、`packages/*/src`）
4. **已安装包的 `lib/types/**/*.d.ts`**（JSDoc 就是契约）
5. **兜底**：解包 `app.asar` 里对应插件的 `client.js` 读实现（行为问题最快）
6. **运行时报错**：DevTools Console；客户端插件里用 `console.warn` 保留可诊断信息

---

## 八、给下一任的三条硬规则

1. **不确定的 API 先在测试 profile 里写探针验证**，绝不在主插件上试——`dsh.client.inject` 写错会直接让 App 起不来。
   （这台机器上 `dsh` 命令不在 PATH，怎么起测试 profile 见 §九）
2. **一次只改一个变量**：先证明"能拿到服务"，再证明"能渲染"，再谈样式与交互。
3. **失败要能在界面上看见**：`console.warn` 只是兜底，最好在面板里显示错误文本；我们靠这一点定位了三次"静默不工作"。

---

## 九、怎么测试一个 Client 插件（不碰日常 profile · 2026-10-24 实测跑通）

> 起因：`diagram-card` 开发完，要在**装进日常 profile 之前**证明它能挂载、能渲染。
> 本机没有安装 `dsh` 命令，但可以用 Electron 的 node 模式跑 `app.asar` 里的 CLI，
> 因此能起一个**完全隔离的测试 profile**——不动桌面端，也不重启正在用的 App。

### 9.1 为什么不能用 headless

`dsh-headless` 的定位是"跑一个任务、打印答案、退出"。官方文档写明它
**没有 GUI、没有服务器、没有浏览器**，profile 里也只有 `dsh-base` + `dsh-headless`。

Client 插件（`dsh.client.platform = "web"`）在那种环境**根本不会被加载**——测了也没有意义。
要测 Client 插件，必须起一个**带渲染器的 web 实例**。

### 9.2 先把 `dsh` 命令跑起来

`dsh` 不在 PATH。它唯一的副本在 `app.asar` 里；普通 `node` 打不开 asar，
但 Electron 自带解包能力，再加 `ELECTRON_RUN_AS_NODE=1` 让它不进 GUI：

```bash
APP="/Applications/DeepSeek Harness.app"
BIN="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"

dsh() { ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" "$BIN" "$@"; }
```

### 9.3 四步起一个隔离测试环境

```bash
# ① 从 web 模板复制一份独立 profile（--dump-config 只打印配置，不启动服务）
dsh --profile probe --from-default-profile web --dump-config

# ② 从 npm 装待测插件
#    会同时写入 dependencies 与 dsh.profile.bundles，不需要手工改两处
dsh plugin --profile probe add "https://registry.npmjs.org/@scope/pkg/-/pkg-0.1.0.tgz"

# ③ 起独立实例（换一个端口，别抢日常端的）
dsh --profile probe --port 19555 --no-open
#    启动日志会打印带 token 的地址：
#    dsh web: http://127.0.0.1:19555/?token=...
#    ⚠️ --profile probe 后面不要再写 web —— 会被当成 app 的参数，报 too many arguments
#    ⚠️ 浏览器必须带 token，否则 401（browser-trust fence）

# ④ 验证完删掉
rm -rf ~/.dsh/profiles/probe
```

### 9.4 三条判据（按顺序断言，失败位置直接指向原因）

| # | 断言什么 | 在页面里怎么验 | 失败说明 |
|---|---|---|---|
| 1 | **模块加载** | `typeof window.__<你的探针>` | 包名 / `exports` / `dsh.client` 声明有问题 |
| 2 | **apply 生效** | slot 注册的**副作用**（例如注入的 `<style>` 是否存在） | slot 名写错，或 `inject` 声明了不存在的服务 |
| 3 | **行为正确** | 注入真实形态的输入 → 等一个扫描周期 → 检查输出 | 选择器或契约不匹配 |

判据 2 的最小验证：插件在 slot 里渲染 `<style>`，检查 `document.querySelectorAll('style')` 里
有没有你的 CSS 前缀。判据 3 要**给观察器留时间**——`MutationObserver` + 轮询的实现通常需要 1~3 秒。

### 9.5 三件事别做

1. **不要拿 desktop profile 做实验**——那是每天在用的那份。测试用 `probe`，用完删。
2. **不要只看"渲染出来了吗"**——同时要确认**原来的内容还在**。替换式渲染必须验证原代码块只是被隐藏、
   而不是被删除（卸载插件后要能退回原样）。
3. **不要跳过清理**——杀进程、释放端口、删 profile；留着会占端口，也会让下一次测试看到脏状态。

### 9.6 这套流程适合什么、不适合什么

| 适合 | 不适合 |
|---|---|
| Client 插件（slot / 渲染 / 样式 / 交互） | Host 半的真实业务链路（要真凭据、真数据） |
| 升级前后的回归对比 | 长会话压力与性能（要真实会话量） |
| 首次挂载验证 | 多用户并发 |

Host 半的路由、子进程、凭据，仍只能按 §二 的方式在真实环境里验。

### 9.7 一次实测记录（照抄即可复现）

```text
① 建 probe（web 模板）                     → ✅
② dsh plugin --profile probe add <tarball>  → ✅ 1.8s，自动写入 bundles
③ dsh --profile probe --port 19555 --no-open
   → dsh web: http://127.0.0.1:19555/?token=…
④ 浏览器里三条判据：
   typeof window.__dshdg                    → 'object'   （模块加载）
   <style> 含 .dshdg-root                   → true       （apply 生效）
   注入 pre>code.language-dsh-diagram，等 3s
     → .dshdg-root 出现                     → true       （行为正确）
     → 原 <pre> display:none                → true       （原内容仅隐藏，未删除）
⑤ 清理：杀进程 / 端口释放 / 删 profile      → ✅
```
