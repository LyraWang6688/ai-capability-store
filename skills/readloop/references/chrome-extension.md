# Chrome 插件契约（readloop-extension）

> 插件是**采集入口**：在浏览器里划词 → 写进用户自己的飞书多维表格。
> 它不参与每日练习的判分与调度；那部分见 `api.md` 与 `SKILL.md`。
> 资产位置：`external-capabilities/plugin/readloop-extension/`（Store-managed）。
> 版本约定：插件的 `manifest.json` `version` = 资产版本；发布 tag `readloop-extension-v<version>`。

## 一、安装

1. 从 Store Release 下载 `readloop-extension-<version>.zip`（或按仓库 README 直接 Load unpacked）
2. Chrome → `chrome://extensions` → 开启 Developer mode → Load unpacked → 选择解压目录
3. 侧边栏「设置」填服务地址：`https://readinsight.bamamei.online`

## 二、配置从哪来

| 配置 | 来源 | 是否要用户手抄 |
|---|---|---|
| 服务地址 | 用户填写 | ✅ |
| `host_token` | 宿主在 `POST /api/setup/app/pair` 时带上，插件用 6 位配对码一次性取回 | ❌ 自动 |
| 飞书 App ID / App Secret | 一键创建飞书应用后，同样通过配对一次性下发 | ❌ 自动 |
| 表格链接 / app_token | 初始化时写入的多维表格 | 手填兜底 |

配对流程见 `api.md` §5.3。**Secret 只在插件本机 `chrome.storage.local`，不上传 Store，也不该出现在对话里。**

## 三、权限与数据边界

- `manifest_version: 3`；权限：`activeTab` / `contextMenus` / `sidePanel` / `storage`
- host 权限：`https://readinsight.bamamei.online/*`、`https://open.feishu.cn/*`、`http://localhost/*`
- 采集内容：用户划选的句子 + 译文 + 诊断结果；只写用户自己的多维表格
- 不做：读浏览历史、后台抓页面、把页面正文发给第三方；诊断只发给用户配置的模型（BYOK）
- 不请求 `<all_urls>`；不注入远程代码

## 四、数据写到哪里

| 表 | 谁写 | 时机 |
|---|---|---|
| `capture_events` | 插件 | 用户点「入库」 |
| `knowledge_points` | 插件（新建/更新） | 同上，按 `归一化内容` 去重 |
| 每日题目 / 判分 / 间隔 | 宿主 + 服务端 | 不经过插件 |

## 五、验证

在插件目录运行：

```bash
node --experimental-vm-modules tools/selftest.mjs   # 逻辑自测（假 chrome.* / fetch）
node tools/browser-smoke.mjs                        # headless 真实加载（需 Playwright）
```

## 六、边界

- **服务端不接触用户的飞书表**：插件直连飞书，服务只负责规则计算
- 本契约只描述插件；服务端点与接口见 `api.md`
- 插件源码与发布在 Store；服务端实现与部署在独立仓库（`readloop-service` 登记为 external）
