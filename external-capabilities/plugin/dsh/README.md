# DSH 插件开发：我们验证过的 API 与边界

> 这份文档只写**我们自己动手验证过**的东西（成功和失败都写），
> 目的是让下一个人不用再把同样的坑踩一遍。
>
> 适用对象：第三方 DSH 插件作者（不是 DSH 官方包开发者）。
> 验证版本：DSH Desktop `0.2.1-rc.2`（2026-10，macOS arm64）。
> AP 可能随版本变化；引用具体行为时请以你当前版本的运行结果为准。

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
| `conversation.chat.*` | 消息流渲染 | 未使用 | 未验证 |

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

---

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

### 4.2 其它坑

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
2. **一次只改一个变量**：先证明"能拿到服务"，再证明"能渲染"，再谈样式与交互。
3. **失败要能在界面上看见**：`console.warn` 只是兜底，最好在面板里显示错误文本；我们靠这一点定位了三次"静默不工作"。
