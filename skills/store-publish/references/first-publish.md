# 首次上传

> 前置：已读完 6 份契约；`reuse_scan.py` 确认注册表里没有这个资产。

> **域相关的规则在 Store 契约里，这份文件不复制它们。**
> 本文件讲三个域**共用**的流程（来源判断 / subtree / 校验 / 人批准 / 打 tag）。
> 具体到某个域的摆放、字段与硬规则，看
> `PUBLISHING.md` §A（Skill）· §B（External Capability）· §C（Automation）。

## 0. 先判断来源是哪种

**两种来源，处理方式不同。先确定你在哪一种。**

```bash
git -C <asset-path> rev-parse --show-toplevel
```

### ① 导入【已有历史】的资产

命令**成功** —— 源是一个 git 仓库。

→ 用 `git subtree` 搬（见 §4），把历史一起带进来。**不要 `cp`。**

### ② 【全新】资产（还没有任何 git 历史）

命令**失败** —— 源不是 git 仓库。

→ **这是正常情况，不是错误。** 直接复制内容，本次提交就记录它的**第一份历史**。

→ 什么时候属于这种情况：资产是在某个 Agent 宿主里做出来的，从来没进过版本控制
（比如放在 `~/.codex/.chatgpt-projects/…` 或 `~/.agents/skills/…` 下）。

→ ⚠️ 但先确认一句：**真的没有历史可迁吗？** 如果它曾经在某个分支/仓库里被提交过，
那就属于情况 ①，应该走 subtree 把那段历史带回来。

### 判定表

| 源是 git 仓库吗 | 有没有可迁移的历史 | 怎么做 |
|---|---|---|
| ✅ 是 | ✅ 有 | `git subtree`（§4），保历史 |
| ❌ 不是 | ❌ 确实没有 | 直接复制，本次记第一份历史 |
| ❌ 不是 | ⚠️ **不确定** | **停下来问王颖** |

**只有「不确定有没有历史」时才需要停下。** 明确是全新资产时，直接复制是正确做法。

## 1. 判定域

| 资产是什么 | 域 | 去哪 |
|---|---|---|
| **怎么做**（SOP / 工作流 / 判断规则 / know-how） | Skill | `skills/` |
| **能调用什么**（MCP / Plugin / CLI / API / Integration） | External Capability | `external-capabilities/` |
| 两者都有 | 两条都走 | 再在 `dependencies/` 记录关系 |

**判据有歧义时停下来问人，不要自己定。**

## 2. Skill 路线

### 2.1 落位

```text
skills/<skill-name>/          ← 必须【恰好一层】，平铺
├── SKILL.md
├── agents/openai.yaml
├── scripts/                  （可选）
├── references/               （可选）
└── assets/                   （可选）
```

`<skill-name>` 必须同时等于：目录名、`SKILL.md` 的 `name`、注册表的 map key。**三者一致。**

### 2.2 写 `SKILL.md`

**frontmatter 只允许 6 个字段**（`SKILL-FORMAT.md` §2）：`name` / `description` / `license` / `compatibility` / `metadata` / `allowed-tools`。

```
⚠️ 不要写 version。版本记在注册表里。
```

`description` 是**触发器**不是介绍——必须写清「做什么」+「什么时候用」。

### 2.3 登记

`skills/registry.yaml`：

```yaml
skills:
  <skill-name>:
    name: <skill-name>
    path: skills/<skill-name>
    scope: shared              # 或 project
    # project: <project-name>  # scope: project 时必填，且 scope 必须是 project
    status: testing            # draft | testing | active | deprecated | archived
    version: 0.1.0             # X.Y.Z；status 为 active 时 major 必须 >= 1
    updated: "YYYY-MM-DD"
```

## 3. External Capability 路线

### 3.1 ⚠️ 先判这个分岔 —— 判错直接废

```text
这个能力是【我们自己维护代码】吗？
  │
  ├─ 是 → Store-managed
  │      代码放 external-capabilities/mcp/<name>/
  │      注册表【必须】填 implementation_path 和 version
  │
  └─ 否 → Pure external（第三方 MCP / API，仓库不托管代码）
         只写 external-capabilities/providers/<provider>/README.md
         注册表【不要】填 implementation_path
```

**反方向的错误是静默失败：**

```
自研能力漏填 implementation_path
  → 验证器完全不检查（判断条件是 `if implementation_path is not None`）
  → 记录看起来合法、全绿通过
  → 但代码不在仓库里 —— 这个能力是个空壳，而且没人会知道
```

### 3.2 登记

`external-capabilities/registry.yaml`：

```yaml
capabilities:
  <capability-name>:
    name: <capability-name>
    provider: <provider>                        # 小写 kebab-case
    type: mcp                                   # plugin|mcp|connector|cli|external-api|integration
    status: limited                             # available|limited|disabled|unknown
    provider_path: external-capabilities/providers/<provider>/README.md   # 必须存在
    version: 0.1.0                              # implementation_path 存在时必填
    implementation_path: external-capabilities/mcp/<capability-name>
    auth: <认证模型>                             # ⚠️ 只写元数据，绝不写凭据值
    capabilities: <这个能力能做什么>
    permissions: <已验证的权限>
    notes: <备注>
```

**`status` 填 `available` 要诚实**——需要额外部署、需要人工授权、只在特定网络可用的，填 `limited`。

### 3.3 写 provider 文档

`external-capabilities/providers/<provider>/README.md` 必须存在（验证器会检查）。

## 4. 把代码搬进 Store（保留历史）

**用 `git subtree`，不要 `cp`。**

```bash
# 来源有远端
git subtree add --prefix=external-capabilities/mcp/<name> <git-url> <branch>

# 来源只有本地、没有远端
git subtree add --prefix=external-capabilities/mcp/<name> <本地绝对路径> <branch>
```

两种都**保留完整的提交历史**。

## 5. 声明依赖（如适用）

Skill 需要某个 Capability 时，写 `dependencies/capability-map.yaml`：

```yaml
dependencies:
  - skill: <skill-name>
    requires:
      - capability: <capability-name>
        required: true
        notes: <可选>
```

## 6. 验证（两道，都要过）

```bash
npx skills-ref validate <store>/skills/<skill-name>
python3 <store>/scripts/validate_store.py
```

## 7. ⛔ 停下 —— 等人批准

**不要在这一步之前提交。** 把下面这些列给王颖：

- 新增 / 修改了哪些文件
- 注册表条目怎么填的（原样贴出来）
- 两道校验的结果
- 任何拿不准的判断

等她明确同意。

## 8. 提交

- 建 feature 分支（**不直推 main**）
- commit message 按 `CONTRIBUTING_AI.md` 的约定，例如 `feat(skill): add <skill-name>`
- 开 PR

## 9. PR 合并后 —— 打不可变版本 tag

**首次上传也要打 tag。** 它是这个资产「第 1 版从哪里开始」的锚点。

### ⚠️ 先读这条：版本号必须在**同一个 PR** 里更新

```
内容变更 和 注册表 version 更新  →  必须在同一个 PR
        ↓
否则【没有任何提交】同时满足"内容是 vX.Y.Z"和"注册表说 vX.Y.Z"
      → tag 打在哪个提交上都不自洽
      → 事后再开一个"对齐版本"的 PR 也【修不了】——
        它修的是当下，修不了 tag 已经指向的那个提交
```

**2026-10 真实发生过 4 次**：`store-publish` 有版本却没有 tag；`teaming-mcp-v0.2.0`、
`teaming-meeting-analysis-v0.1.1` 与 `v0.1.2` 的 tag 指向的提交里，注册表还写着旧版本。
期间开过两次"对齐已打的 tag"的补丁 PR —— **它们都没能修好那几个 tag**，因为历史改不了。

### 打之前先跑自查

```bash
python3 <store>/skills/store-publish/scripts/check_tag_version.py <asset-name> <version> [<commit>]
```

它检查四件事，逐条报告：

```
① tag 名还没被占用      —— 版本 tag 不可重用；内容变了就升版本，不要重指
② 资产在两个域注册表之一里登记了
③ 在目标提交上，注册表说的版本 == 你要打的版本   ← 就是上面那条
④ 目标提交从 main 可达  —— 不要在 feature 分支上打，分支删了 tag 会悬空
```

- 退出 `0` = 可以打；退出 `10` = **不能打**（逐条说明原因）；`2` = 用法/环境错误
- 想体检全仓已有的 tag：`check_tag_version.py --audit`

**为什么不做进 `validate_store.py`**：那支验证器是**纯文件系统**的（不调 git、不调子进程），
所以 tarball、浅克隆、`.git` 被剥掉的副本都能校验。tag 是 git 问题，属于另一个工具 ——
而 PR 的 CI 里也做不了（那时 tag 还没打，会 100% 误报）。见 Issue #23。

### 打 tag

```bash
git checkout main && git pull
python3 <store>/skills/store-publish/scripts/check_tag_version.py <asset-name> <version>
git tag -a <asset-name>-v<X.Y.Z> <合并后的提交> -m "<asset-name> v<X.Y.Z>

<一两句：这是什么资产、status 是什么、有什么前提>"
git push origin <asset-name>-v<X.Y.Z>
```

例：

```bash
git tag -a repo-hygiene-v0.1.0 a28a72a -m "repo-hygiene v0.1.0

First Store registration. Status: testing."
git push origin repo-hygiene-v0.1.0
```

### 为什么必须打

注册表里 `version: 0.1.0` **只是一个字符串**。没有 tag，它指不到任何提交 ——
「回滚到 0.1.0」「钉住 0.1.0」这些说法都无法执行。

而且 `VERSIONING.md` §6 规定不可变历史由**名字空间 tag**承载，§7 规定消费方可以钉到 tag。
**不打 tag，这两条契约就是空的。**

### 三条禁令

```
⚠️ 绝不要用 v0.1.0 这种全仓通用的 tag
   —— 一个仓库装多个资产，必然撞车。
   <asset-name>-v<X.Y.Z> 里的资产名不能省。

⚠️ 必须用 -a 打【附注 tag】，不要用轻量 tag
   轻量 tag 只是一个指针；附注 tag 才记录打 tag 的人、时间、说明，
   也就是"这一版是什么时候、由谁发布的"。

⚠️ 出错了不要慌，tag 是可逆的
   删本地: git tag -d <name>
   删远端: git push origin --delete <name>
   改类型: 删掉再用 -a 重打，指向同一个提交即可
```

### 打在哪个提交上

**打在「PR 合并进 main 之后」的 main 上** —— 也就是承载这次上传的那个提交。

⚠️ 前提是那个提交里**注册表已经写对了版本**。所以版本更新要么在同一个 PR 里，
要么那个"对齐版本"的 PR 先合、再打 tag。`check_tag_version.py` 就是替你确认这一点。

不要在 feature 分支上打：分支会被删除，tag 会跟着变成一个悬空引用。
