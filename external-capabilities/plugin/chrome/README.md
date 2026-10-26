# Chrome 扩展（plugin/chrome）

浏览器侧插件生态：用户自己安装、由页面与侧边栏驱动，不需要宿主进程托管。

| 资产 | 说明 |
|---|---|
| [`readloop-extension/`](./readloop-extension/) | ReadLoop 采集插件：划词 → 翻译诊断 → 写用户自己的飞书表 |

与 `plugin/dsh/` 的区别：dsh 插件装进 AI Host（DSH）的 profile，由宿主进程加载；
Chrome 扩展装进浏览器，由用户手动 Load unpacked / 商店安装。
两者都是 `type: plugin`，生态目录只做分组，不改变校验规则（生态下的资产仍必须登记 implementation_path）。
