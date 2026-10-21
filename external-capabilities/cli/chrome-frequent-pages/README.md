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
| `ignored_urls_file` | 忽略清单（一行一个 URL）；表里删掉的行会写进这里，避免下次重新收录 |
| `rules.drop_hosts` | 整站丢弃（娱乐视频站等）|
| `rules.drop_url_contains` | URL 含指定片段即丢弃（开发者后台、PR/Releases、OAuth、支付等）|
| `rules.root_only_hosts` | 只保留站点根域名（如 `github.com` 只留首页）|
| `rules.drop_titles` | 标题命中即丢（失效/无权限文档）|
| `rules.keep_urls` | 白名单，优先级最高 |
| `rules.one_per_host` | 每个域名只保留访问最多的一页 |

## 规则（学自实际操作）

```json
"rules": {
  "drop_hosts": ["yfsp.tv", "iyf.tv", "yifan.tv"],
  "drop_url_contains": ["open.feishu.cn/app", "open.feishu.cn/document", "/pulls", "/releases", "checkout", "oauth"],
  "root_only_hosts": ["github.com"],
  "drop_titles": ["Docs", "没有权限访问", "File not found"],
  "keep_urls": ["https://platform.deepseek.com/api_keys"],
  "one_per_host": true
}
```

## 写入策略

- 以 `URL` 去重：已存在则更新访问次数/最近访问，不存在才新建；
- 同一页面不同 query/fragment 会归一化成同一条（飞书 `/base/<token>`、`/wiki/<token>` 按 token 聚合）；
- 状态默认「已收录」，方便你之后标「已加入书签」或「忽略」；
- 忽略清单：`~/.config/chrome-frequent-pages/ignored_urls.txt`，一行一个 URL，命中即跳过；
  在表里删掉的页面记得同步进这个文件（或让工具写）。

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
