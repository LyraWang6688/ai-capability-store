# scripts/tag-audit/ — 版本与标签一致性检查

三个脚本合起来回答一个问题：**registry 说的版本、git 的标签、发布出去的 artifact，三者在说同一个版本吗？**

| 脚本 | 作用 |
|---|---|
| `check_tag_version.py` | 主工具。默认查「即将创建的 tag 是否安全」；`--audit` 扫全部 tag；`--missing` 查「登记的版本有没有漏打 tag」；`--package` 查「artifact 的 `package.json` 与 registry 是否一致」 |
| `domains.py` | 每个域在它自己 registry 里的条目键（`skills:` / `capabilities:` / `automations:` / `orchestrations:`）。两个消费者共用，避免一个工具更新、另一个还按旧域回答 |
| `store_root.py` | 定位 Store 检出（`$AI_CAPABILITY_STORE` → 常见路径 → 向上查找） |

## 为什么在公开仓库里

上架流程（`store-publish` skill）是**本地专用**的内部手册，被 gitignore 了；但版本/标签检查是**公开契约**的一部分 —— `VERSIONING.md` §6 要求每个版本都有 tag，CI 每周也要扫一遍漏打的版本。把检查器和流程手册分开，CI 才能在公开仓库里继续跑：

| 位置 | 状态 | 跑在哪 |
|---|---|---|
| `scripts/tag-audit/check_tag_version.py`（本目录） | 公开 | PR CI（`--package`）+ 每周一（`--missing`） |
| `~/.agents/skills/store-publish/` | 私有、不入库 | 操作者本机（上架 / 迭代流程） |

本地专用 skill 只是本目录脚本的调用方；`reuse_scan.py` 也从这个目录拿 `store_root` / `domains`，保证两个工具对「域」的理解一致。

## 用法

```bash
python3 scripts/tag-audit/check_tag_version.py <asset> <version>   # 打 tag 之前
python3 scripts/tag-audit/check_tag_version.py --audit            # 扫全部 tag
python3 scripts/tag-audit/check_tag_version.py --missing          # 漏打的版本
python3 scripts/tag-audit/check_tag_version.py --package HEAD     # artifact 版本
```

退出码：`0` 一致 / `10` 不一致（可预期的「否」）/ `2` 环境或用法错误。

需要 PyYAML：`pip install -r requirements-dev.txt`。
