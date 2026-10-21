# chrome-frequent-pages

**把 Chrome 里高频访问的网页收录进飞书「常用网页」表，并生成可导入 Chrome 的书签 HTML。**

只读 Chrome History（复制到临时目录后再读，不锁 Chrome），归一化 URL 后按
「域名 + 路径」聚合访问次数，过滤登录页 / 搜索页 / 本地地址。

## 用法

```bash
# 配置（默认 ~/.config/chrome-frequent-pages/config.json）
cp config.example.json ~/.config/chrome-frequent-pages/config.json

python3 main.py --dry-run                     # 只看结果
python3 main.py --write                       # 写/更新飞书表
python3 main.py --html ~/Desktop/常用网页.html  # 导出可导入 Charter 的书签 HTML
python3 main.py --days 30 --min-visits 5      # 临时调窗口与阈值
```

## 配置字段

| 字段 | 说明 |
|---|---|
| `chrome_profile_dir` | Chrome profile 目录（默认 `~/Library/Application Support/Google/Chrome/Default`）|
| `days` | 统计窗口（默认 90 天）|
| `min_visits` | 最少访问次数（默认 8）|
| `limit` | 最多收录条数（默认 60，`0` = 不限）|
| `exclude_hosts` | 排除的域名（邮箱、登录等）|
| `base_token` / `table_id` | 目标飞书表坐标 |
| `identity` | `user`（默认）或 `bot` |

## 写入策略

- 以 `URL` 去重：已存在则更新访问次数/最近访问，不存在才新建；
- 同一页面不同 query/fragment 会归一化成同一条（飞书 `/base/<token>`、`/wiki/<token>` 按 token 聚合）；
- 状态默认「已收录」，方便你之后标「已加入书签」或「忽略」。

## 书签替换（安全流程）

1. 先备份 Chrome 当前书签：
   `cp "~/Library/Application Support/Google/Chrome/Default/Bookmarks" ~/Desktop/Bookmarks-backup-$(date +%F).json`
2. 跑 `--html` 生成新书签 HTML；
3. Chrome → 书签管理器 → 删除旧书签 → 导入 HTML；
4. 不建议直接改 `Bookmarks` JSON：Chrome 运行时会覆盖，写坏会丢全部书签。

## 定时（可选）

```bash
bash install.sh   # 生成 ~/.local/bin/chrome-frequent-pages 并注册每周一 09:30 的 launchd 任务
```
