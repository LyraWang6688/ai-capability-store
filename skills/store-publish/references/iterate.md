# 迭代

> 前置：`reuse_scan.py` 确认注册表里**已有**这个资产。

## 0. 先读现状

- 它在哪个注册表？当前的 `status` / `version` / `updated` 是什么？
- 读目标实体本身，再动手（`AGENTS.md` 必读顺序第 9 项）。
- 按顺序重读 6 份契约——**规则可能已经变过**。

## 0b. 改动从哪来？—— 先判断这一条

```
这个资产的内容，是【住在 Store 里】，还是要【从别处同步】？
  │
  ├─ 注册表 notes 声明「以 Store 为准 / 不再 subtree」 → 往下走 §1（直接在 Store 改）
  │
  ├─ 直接在 Store 里改                  → 往下走 §1（正常迭代）
  │
  └─ 源仓库在别处，改的是那边            → 走 §0c（subtree pull 同步）
      （首次导入时用了 git subtree 的，都属于这种）
```

**怎么判断（按顺序，前一条命中就停）：**

1. **先读注册表该条目的 `notes`。** 若里面声明了同步模式（例如
   *「以 Store 为唯一准据，不再使用 git subtree」*），**以它为准**——
   这类资产直接在 Store 里改，**不要**去源仓库改，**更不要**跑 `git subtree pull`。
2. 没声明时，再看 `implementation_path`，以及当初是怎么搬进来的——
   用了 `git subtree add` 的就是**镜像**关系。

> ★ 为什么第 1 条优先：**「用过 `git subtree add`」不等于「现在还在同步」。**
>
> 资产可能中途变成 Store 原生——源仓库退休、被删，或维护者决定直接在 Store 改。
> 但改动历史里仍留着 subtree 的痕迹，`git log` 只显示「这个资产又更新了」，
> **从提交历史看不出它已经不再是镜像**。
>
> 一条曾经写错、后来被实测证伪的判断（记在这里免得再犯）：原以为
> 「锚点冻结 → `pull` 会拿很旧的基线去合 → 必然冲突」。**不成立**——
> 从源仓库分支 `pull` 时 git 按 merge-base 算真实差异，实测**零冲突**，
> 而且它会把漏同步的文件一并补上。所以「会不会冲突」不能当判据。
>
> 唯一可靠的判据是：**这个资产现在还有没有可用的上游。** 这件事只有维护者
> 知道，所以必须写进注册表的 `notes` 里。
>
> 现实案例：`teaming-mcp` 0.1.0 用 subtree 导入，0.1.1–0.1.3 继续 `pull`
> （提交在 Store 历史里可达），0.2.0 改成手工同步，2026-10-18 源仓库退休删除、
> 正式宣布以 Store 为准。此时如果还按「用过 subtree add」去 `pull`，
> 已经没有上游可拉了。

## 0c. 源仓库在别处 —— 用 subtree pull 同步

### ⚠️ 先记住：不要在 Store 里单方面改

```
源仓库（比如 ~/Documents/workplace/wechat-draft-mcp）
        │  git subtree add
        ↓
Store（external-capabilities/mcp/<name>/）
        ↑ 这两份是【镜像】
```

**在 Store 里单方面改镜像内容，会破坏这层关系** —— 下次 pull 冲突，
而且两个仓库从此说的不是一回事。

→ **要改就在源仓库改，再 pull 回来。**

### 步骤

```bash
# ① 在源仓库改并提交
cd <源仓库路径>
# …编辑、测试…
git add -A
git commit -m "<按源仓库自己的规范>"

# ② pull 进 Store（先开 feature 分支，不直推 main）
cd <store>
git checkout -b <feature-branch>
git subtree pull --prefix=<prefix> <源仓库路径> <branch>

# ③ 注册表要跟着变就改它（版本、notes……）
# ④ 回到 §3 往下走：验证 → 停下等人批准 → 提交
```

- `<prefix>` 就是注册表里 `implementation_path` 的值，
  例如 `external-capabilities/mcp/wechat-draft-mcp`
- ⚠️ `git subtree pull` **只 pull 已提交的内容**。
  源仓库有未提交改动 → 先提交，**或者先停下来问王颖**
- ⚠️ 不确定这次改动该在源仓库做还是在 Store 做 → **停下来问王颖**

## 1. 判断改动级别

依据 `VERSIONING.md` §4：

| 级别 | 什么时候升 |
|---|---|
| **PATCH** | 向后兼容的修正 |
| **MINOR** | 向后兼容的能力新增 |
| **MAJOR** | 破坏性变更 / 行为不兼容 |

```
⚠️ VERSIONING.md 没有规定"谁有权升 MAJOR"。
   遇到 MAJOR 时【停下来问王颖】，不要自己决定。
```

## 2. 改内容

- **路径不变。** 升级版本不改目录（`VERSIONING.md` §3）。
- Skill：`SKILL.md` frontmatter 仍然只能用那 6 个字段；**不要因为升版本就去写 `version`**。
- External Capability：如果代码变了，确认 `implementation_path` 仍然指向对的目录。

## 3. 改注册表

```yaml
    version: <新版本号>
    updated: "YYYY-MM-DD"
```

**只改这两项（以及内容有变化时相应字段）。不要顺手改别的资产的记录。**

## 4. 验证（两道）

```bash
npx skills-ref validate <skill-path>
python3 <store>/scripts/validate_store.py
```

## 5. ⛔ 停下 —— 等人批准

列给王颖：改了什么、从哪个版本升到哪个版本、为什么是这个级别、校验结果。**等她同意。**

## 6. 提交 + 打 tag

- feature 分支 → PR（不直推 main）
- commit message：`update(skill): refine <skill-name>`（或 capability 对应写法）
- **合并后**打名字空间 tag —— 用**附注 tag**（`-a`）：

```bash
git checkout main && git pull
python3 <store>/skills/store-publish/scripts/check_tag_version.py <asset-name> <version>
git tag -a <asset-name>-v<X.Y.Z> <合并后的提交> -m "<asset-name> v<X.Y.Z>

<一两句：这次发布了什么、status 是什么>"
git push origin <asset-name>-v<X.Y.Z>
```

```
⚠️ 版本号必须在【同一个 PR】里改（第 3 步），不能事后再补一个"对齐版本"的 PR。
   拆开之后，没有任何提交同时满足"内容是 vX.Y.Z"和"注册表说 vX.Y.Z"，
   tag 打在哪个提交上都不自洽 —— 而事后补的 PR 修不了 tag 已指向的那个提交。
   （first-publish.md §9 有完整说明；2026-10 真实发生过 4 次。）

⚠️ 打之前先跑上面那条 check_tag_version.py；退出 10 就不要打。

⚠️ 不要用 v0.1.0 这种全仓通用的 tag —— 一个仓库装多个资产，会撞车。
   （VERSIONING.md §6）

⚠️ 必须用 -a 打【附注 tag】，不要用轻量 tag。
   轻量 tag 只是一个指针；附注 tag 才记录打 tag 的人、时间、说明，
   也就是"这一版是什么时候、由谁发布的"。

⚠️ 打在【已合并进 main 之后】的提交上，不要在 feature 分支上打
   —— 分支会被删除，tag 会变成悬空引用。
```

## 7. 不删历史

如果这次改动**推翻了旧判断**，按 `CONTRIBUTING_AI.md` 的方式记录演化，不要静默覆盖：

```
原判断
  ↓
发生了什么
  ↓
为什么改变
  ↓
新判断
```

**一个资产的历史版本由 tag 承载，永不删除**（`VERSIONING.md` §6）。"回滚到 v1.2.0" 是 `git checkout <asset>-v1.2.0`，不是删掉后面的版本。
