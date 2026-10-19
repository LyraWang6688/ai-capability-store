# deepseek-invoice

每月自动为 **DeepSeek 开放平台**（`platform.deepseek.com`）申请开具企业增值税普通发票。

## 它做什么

1. 用 headless Chromium 打开 `https://platform.deepseek.com/transactions`
2. 校验登录态（失效则退出码 2）
3. 点「发票管理」，读「可开票金额」
4. 金额 ≤ 0 → **跳过**（幂等，不重复开票）
5. 金额 > 0 → 选「按充值金额开票」，填固定抬头 / 税号 / 邮箱 / 增值税普通发票，填全额并提交
6. 输出 JSON（stdout 末尾 `@@RESULT@@`）+ 日志与截图（`local-file`）

## 为什么需要 `systemd` 执行器

| 备选 | 为什么不行 |
|---|---|
| `github-actions` | 需要**长期登录态**（浏览器 token）且平台有**风控**；云端 runner 每次 IP 不同且在境外，会被判为可疑 |
| `launchd` | 目标机是 Linux，不是 macOS |
| `human` | 这是无人值守的月度定时任务 |

## 输入（不入库）

| 文件 | 说明 |
|---|---|
| `config.json` | 抬头 / 税号 / 邮箱 / `maxAmount`；权限 `600` |
| `auth/storage-state.deepseek.json` | 登录态（cookie + localStorage 的 `userToken`），约 6KB；权限 `600` |

## 运行

```bash
node run.mjs --dry-run     # 只读：读金额、不提交
node run.mjs --live        # 真提交（金额 > 0 且未超上限时）
```

退出码：

| 码 | 含义 |
|---|---|
| 0 | 成功（含「金额为 0，跳过」） |
| 1 | 未捕获异常 |
| 2 | 登录失效，需重新导出登录态 |
| 3 | 金额超过 `maxAmount`，已中止 |

## 登录态维护

登录态会过期。刷新步骤：

1. 本地 Chrome 登录 `https://platform.deepseek.com`
2. 导出并裁剪为只含 deepseek 的 storageState（`cookies` 过滤 `domain` 含 deepseek；`origins` 只留 `platform.deepseek.com`）
3. `scp` 到目标机 `/opt/deepseek-invoice/auth/storage-state.deepseek.json`
4. `chmod 600`

失效信号：systemd 退出码 2，日志里出现「登录态失效」。

## 安全设计

- **默认 dry-run**；只有 systemd unit 里显式 `--live`
- `maxAmount` 金额上限保护，超过即中止（退出码 3）
- 金额为 0 直接跳过，天然幂等
- 登录态与配置被 `.gitignore` 排除，不进仓库
- 只操作 DeepSeek 一站点的账单页，不触碰其它系统

## 定时

`deploy/deepseek-invoice.timer`：`OnCalendar=*-*-01 10:00:00`，`Persistent=true`（错过会补跑）。

## 已知限制

- 发票抬头是 DeepSeek 自研的自动补全组件，**「有额度」场景尚未真机验证**；脚本按「输入 → 等下拉 → 点第一项」处理，首次真实提交建议人工旁看。
- 页面改版会导致选择器失效；脚本失败即非 0 退出，不会静默继续。

## 部署

```bash
bash automations/deepseek-invoice/deploy/install.sh
```
