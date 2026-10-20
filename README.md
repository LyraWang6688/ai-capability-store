# mac-cleanup

季度性 macOS 清理。跑一次，出一份报告，**只有异常才需要人介入**。

基于 [Mole](https://github.com/tw93/Mole)（`mo`）。

> 这个工具的设计前提：`mo clean` 本身是好的，但**没人盯着的时候它会静默出错**——
> 白名单被替换掉、汇总数字虚报、删掉不该删的运行时。本项目的全部价值就是这三道护栏。

---

## 安装（三步）

```bash
brew install mole                 # 依赖：Mole（没有它就没法工作）
git clone <repo> mac-cleanup && cd mac-cleanup

./mac-cleanup.sh --init           # ① 扫描本机，生成配置与清单（必做一次）
./mac-cleanup.sh --check          # ② 只体检+预演+出报告，【不删任何东西】
./install.sh                      # ③ 满意后再装季度定时任务
```

`--init` 会打印它探测到了什么。**如果 `--check` 的报告正常，就可以 `./install.sh`。**

要求：macOS 12+、bash（系统自带 3.2 即可）、Homebrew 装的 Mole。不需要 Python / Node。

---

## 它解决什么问题

直接 `mo clean` 每季度跑一次也行。但我们在 2026-10 亲历了三件事：

| 翻车 | 如果没人盯着 |
|---|---|
| Mole 白名单是**替换**语义 | 手工少写一条 → 内置保护**静默失效** |
| Mole 汇总**不可信** | 一次少报 3.4 倍（10.43GB vs 实际 35.83GB）；一次虚报 2275MB（实为跳过） |
| 工具**不知道你的依赖** | 差点删掉 DSH 运行时（164 个符号链接指向它） |

这三条都变成了自动检查，而不是靠人记得。

## 为什么是「脚本 + launchd」而不是 Skill

例行清理是**完全确定性**的：

- `mo clean` 有原生非交互模式（stdin 非 TTY 时自动跳过系统缓存、不弹确认）
- 保护靠白名单**一次性建立**，不需要每季度重新判断

所以日常路径**不需要 LLM、不需要 Agent 在场**。Skill 只在异常路径才有价值。

---

## 六个阶段

```
① guard      白名单完整性 + 空条目检查      ← 不过就【中止】，一条都不删
② snapshot   mo clean --dry-run 存档
③ clean      mo clean < /dev/null          ← 非交互，自动跳过系统缓存
④ verify     日志逐条加总 vs Mole 自报 vs df
⑤ health     关键符号链接 / 关键资产体检
⑥ report     写 ~/Library/Logs/mac-cleanup/<年>-Q<季>.md
```

## 三个不变量

| # | 不变量 | 为什么 |
|---|---|---|
| 1 | **白名单不完整 → 中止，绝不清** | 宁可这个季度不清，也不能裸奔 |
| 2 | **不 sudo** | 系统缓存收益小、风险高，且无法无人值守 |
| 3 | **不信 Mole 的汇总** | 只认 `operations.log` 逐条加总 + `df` |

---

## 本机适配：`--init` 生成什么

这个项目**不含任何硬编码的本机路径**。所有机器相关的信息由 `--init` 探测并写入
**5 个 gitignore 的本地文件**：

| 文件 | 内容 | 怎么来的 |
|---|---|---|
| `config.local.sh` | mo 路径、launchd 标签、报告目录、DSH 运行时 | 探测 + 现有配置 |
| `whitelist.reference` | 白名单基准（内置保护 + 本机额外保护） | 从**已安装的 Mole 源码**提取内置模式，再从现有 `~/.config/mole/whitelist` 并入你的条目 |
| `expect-absent.list` | 允许"命中不到路径"的条目 | 自动算出基准里本机当前不存在的条目，避免季度噪音 |
| `critical.list` | 必须存在的关键资产 | 只写探测到真实存在的 |
| `watch.list` | 只观察、不判失败的资产 | 一份通用清单 |

**探测机制**（`lib/detect.sh`）：

- **mo 路径**：`command -v mo` → `/opt/homebrew/bin` → `/usr/local/bin` → `~/.local/bin`（Intel/Apple Silicon 都覆盖）
- **Mole 源码**：从 mo 的真实路径反推 `libexec/lib/core/base.sh`，再兜底 `brew --prefix mole`
- **DSH 运行时**：从 `~/.dsh/profiles/node_modules` 的**符号链接反查** `~/.npm/_npx/<hash>` —— 这个哈希每台机器不同，硬编码必错
- **非 DSH 用户**：探测不到就自动跳过相关检查，不误报

> 重新初始化（会备份旧文件）：`./mac-cleanup.sh --init --force`

---

## 三道护栏

### ① `guard.sh` —— 白名单体检（最要命的一道）

- 逐条比对 `whitelist.reference` → 少一条就 **FAIL 并中止**
- 从已安装 Mole 源码提取内置模式交叉验证（提取不到则降级为 WARN）
- **空条目检查**：白名单里每条是否命中得到真实路径
  → 这道检查当场抓到过"父目录写错"（`Application Support/...` 应为 `Caches/...`，导致 1.13GB 静默失去保护）
  → 内置默认不参与这项检查（跨用户通用，本机没装 Gradle/Ollama 很正常）

### ② `verify.sh` —— 不信汇总，回读日志

从 `operations.log` 逐条加总 `REMOVED` 的体积与条数，与 Mole 自报、`df` 实测三方对照，
偏差 > 20% 判 `MISMATCH`。用真实历史日志测过，成功抓出 Mole 71% 的偏差。

### ③ `health_check` —— 关键资产体检

- DSH profile 的符号链接是否悬空（**只有 DSH 用户才检查**）
- `critical.list` 里的资产是否还在
- 探测到的 DSH 运行时是否仍在白名单里

---

## 报告怎么读

只看两处：

1. **实际释放** —— `df` 实测算出来的，不是 Mole 说的
2. **需要人看的情况** —— 只有下面任意一条出现才需要介入

| 信号 | 含义 | 动作 |
|---|---|---|
| `白名单体检 FAIL` | 已中止，没清任何东西 | `./mac-cleanup.sh --init --force` 重建，或手动补白名单 |
| `结果核对 MISMATCH` | Mole 自报与日志差 > 20% | 看 `verify.txt`；通常是统计口径问题，不是删错 |
| `关键资产体检 BROKEN/MISSING` | 可能影响运行时 / IDE / iCloud | **立刻处理** |
| dry-run 里出现没见过的大目录 | 可能是新 App 缓存，也可能重要 | 下次清理前手动确认 |

---

## 已知的坑

| 坑 | 症状 | 对策 |
|---|---|---|
| 白名单是**替换**语义 | 手工只写几行 → 内置保护全失效 | `guard.sh` ① 比对基准，FAIL 就中止 |
| 白名单路径写错父目录 | 不报错、只是永不命中 | `guard.sh` ③ 空条目检查 |
| Mole 汇总不可信 | 少报 / 虚报 | `verify.sh` 逐条加总 |
| 工具不知道你的依赖 | 会删掉运行时（如 DSH 的 npx 目录） | `--init` 反查并写入基准 + 每次体检 |
| launchd 的 PATH 极简 | 找不到 `mo` | 脚本内全部动态解析绝对路径；plist 也显式给 PATH |
| **`mo --version` 第一行是空行** | 版本解析为空 | `detect.sh` 用 `sed` 找 version 行，不用 `head -1` |
| Full Disk Access | 某些 `~/Library` 路径扫不全 | 首次跑完对比释放量与手动跑；差距大就去给 `/bin/bash` 授权 |
| 睡眠/关机错过时间点 | 没跑 | launchd 会在唤醒后补跑；关机跨过不累积 |
| Mole 也扫 `$TMPDIR`/`/var/folders` | 与 `$HOME` 无关 | 本项目不依赖重定向 HOME 做隔离（只影响测试方式） |

---

## 不做什么

- ❌ **不清系统级缓存**（`/Library`、`/var` 需要 sudo 的那部分）
- ❌ **不删 `REVIEW` 类东西**（比如指向已卸载 App 的孤儿登录项）→ 只在报告里提示
- ❌ **不碰 `mo` 之外的东西** → 没有自研删除逻辑

---

## 文件结构

```
mac-cleanup/
├── mac-cleanup.sh             主入口（--init / --check / 完整跑）
├── lib/
│   ├── common.sh              配置加载 / 日志 / 单位换算 / 报告生成
│   ├── detect.sh              本机探测（mo / Mole 源码 / DSH 运行时）
│   ├── init.sh                --init 向导（生成 5 个本机文件）
│   ├── guard.sh               白名单体检 ← 最重要的护栏
│   └── verify.sh              日志核对 + 关键资产体检
├── config.default.sh          默认配置（可提交）
├── deploy/
│   └── launchd.plist.template LaunchAgent 模板（label/路径在安装时替换）
├── install.sh                 安装 / 卸载 / 状态 / 立即触发
└── README.md

本机生成（gitignore，不入库）：
config.local.sh · whitelist.reference · expect-absent.list · critical.list · watch.list
```

## 开发与测试

```bash
# 语法检查
for f in mac-cleanup.sh install.sh lib/*.sh config.default.sh; do bash -n "$f" || echo "FAIL $f"; done

# 端到端冒烟（重定向 HOME，只跑 --check，不删东西）
TESTHOME="$(mktemp -d)"; mkdir -p "$TESTHOME/.config/mole"
HOME="$TESTHOME" bash ./mac-cleanup.sh --init
cp whitelist.reference "$TESTHOME/.config/mole/whitelist"
HOME="$TESTHOME" bash ./mac-cleanup.sh --check
```

> ⚠️ 重定向 `HOME` **不是**完整沙箱：Mole 还会扫 `$TMPDIR`、`/var/folders` 等与 HOME 无关的路径。
> 所以冒烟测试**只允许跑 `--check`（dry-run）**，绝不能做真实清理。
