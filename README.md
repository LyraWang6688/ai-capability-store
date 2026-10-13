# mac-cleanup

季度性 macOS 清理。跑一次，出一份报告，**只有异常才需要人介入**。

基于 [Mole](https://github.com/tw93/Mole)（`mo`，Homebrew 装：`brew install mole`）。

---

## 为什么是「脚本 + launchd」而不是 Skill

例行清理是**完全确定性**的：`mo clean` 有原生非交互模式（`clean.sh:1600`，stdin 非 TTY 时自动跳过系统缓存、不弹任何确认），保护由白名单一次性建立。所以日常路径**不需要 LLM、不需要 Agent 在场**。

Skill 只在**异常路径**才有价值（冒出个没见过的大目录、核对失败、要改白名单）——那些不是每季度都会发生的事。

---

## 三个不变量

| # | 不变量 | 为什么 |
|---|---|---|
| 1 | **白名单不完整 → 中止，绝不清** | Mole 的白名单是**替换**语义。`~/.config/mole/whitelist` 一旦存在，内置 19 条保护就全靠这个文件；少一条 = 静默失去一条保护 |
| 2 | **不 sudo** | 系统缓存收益小、风险高；`mo clean` 在非交互下会自动跳过 |
| 3 | **不信 Mole 的汇总** | 实测：第 3 轮少报 3.4 倍（10.43 vs 35.83GB）；另一处虚报 2275MB（实为 SKIPPED）。只认 `operations.log` 逐条加总 + `df` |

---

## 用法

```bash
./mac-cleanup.sh --check     # 只体检 + 预演 + 出报告，【不删任何东西】← 建议先跑这个
./mac-cleanup.sh             # 完整跑：guard → snapshot → clean → verify → health → report
./install.sh --dry-run       # 看看要装的 plist 长什么样
./install.sh                 # 安装季度定时任务
./install.sh --status        # 查看状态 / 下次运行时间 / 最近报告
./install.sh --run-now       # 立刻触发一次
./install.sh --uninstall     # 卸载
```

跑完的报告在 `~/Library/Logs/mac-cleanup/<年>-Q<季>.md`，每次运行的原始产物在
`~/Library/Logs/mac-cleanup/work/<时间戳>/`。

---

## 六个阶段

```
① guard      白名单完整性 + 空条目检查        ← 不过就中止
② snapshot   mo clean --dry-run 存档
③ clean      mo clean < /dev/null            ← 非交互，自动跳过系统缓存
④ verify     日志逐条加总 vs Mole 自报 vs df
⑤ health     DSH 符号链接 / 关键资产体检
⑥ report     写 markdown 报告
```

带 ★ 的是护栏，**不要为了"跑得通"把它们关掉**。

---

## 报告怎么读

只看两处：

1. **实际释放** —— 用 `df` 实测算出来的，不是 Mole 说的
2. **需要人看的情况** —— 只有下面任意一条出现才需要你介入：

| 信号 | 含义 | 动作 |
|---|---|---|
| `白名单体检 FAIL` | 已经中止，没清任何东西 | 去补白名单，或 `cp whitelist.reference ~/.config/mole/whitelist` |
| `结果核对 MISMATCH` | Mole 自报与日志加总差 > 20% | 看 `verify.txt`；通常是 Mole 统计口径问题，不是删错 |
| `关键资产体检 BROKEN/MISSING` | 可能影响 DSH / IDE / iCloud | **立刻处理** |
| dry-run 里出现没见过的大目录 | 可能是新 App 的缓存，也可能是重要数据 | 下次清理前手动确认 |

---

## 已知的坑（都踩过）

| 坑 | 症状 | 本项目的对策 |
|---|---|---|
| **白名单是替换语义** | 手工只写几行 → 内置 19 条保护全部失效 | `guard.sh` ① 逐条比对基准清单 → FAIL 就中止 |
| **白名单路径写错父目录** | 不报错、只是永远不命中 → 静默无保护 | `guard.sh` ③ 空条目检查（命中不到真实路径就 WARN） |
| **Mole 汇总不可信** | 少报 / 虚报 | `verify.sh` 从日志逐条加总，与自报对比 |
| **工具不知道你的依赖** | 会删掉 DSH 运行时（`~/.npm/_npx/1e7…`，164 个符号链接指向它） | 写进 `whitelist.reference` + `health_check` 每次确认 |
| **launchd 的 PATH 极简** | 脚本找不到 `mo` | `common.sh` 里全部用绝对路径；plist 里也显式给 PATH |
| **launchd 无 TTY** | `mo clean` 会不会卡住？ | 不会——非交互模式是 Mole 官方支持的路径 |
| **Full Disk Access** | 某些 `~/Library` 路径扫不全 | 首次跑完，把报告里的释放量与手动跑对比；差距大就去 系统设置 → 隐私与安全性 → 完全磁盘访问权限 里给 `/bin/bash` 授权 |
| **睡眠/关机错过时间点** | 没跑 | launchd 会在唤醒后补跑；关机跨过则不累积 |

---

## 不做什么

- **不清理系统级缓存**（`/Library`、`/var` 那些需要 sudo 的）。收益小、风险高，且无法无人值守。要清就手动 `sudo -v && mo clean`。
- **不删 `REVIEW` 类的东西**。比如 Mole 报的"孤儿登录项"（指向已卸载 App 的 LaunchAgent）——它自己不敢删，本项目也不删，只在报告里提示。
- **不碰 `mo` 之外的东西**。没有自研的删除逻辑；所有删除都经过 Mole 自己的白名单与安全规则。

---

## 文件结构

```
mac-cleanup/
├── mac-cleanup.sh                       主入口（六阶段编排）
├── lib/
│   ├── common.sh                        路径 / 日志 / 单位换算 / 报告生成
│   ├── guard.sh                         白名单体检（最重要的一道护栏）
│   └── verify.sh                        日志核对 + 关键资产体检
├── whitelist.reference                  必须存在的最小保护集（guard 的基准）
├── launchd/
│   └── com.wangying.mac-cleanup.plist.template
├── install.sh                           安装 / 卸载 / 状态 / 立即触发
└── README.md
```

`whitelist.reference` 是**最小集**，不是完整白名单：你的实际白名单可以比它多（多出来的就是额外保护），但不能比它少。

---

## 首次上线建议

1. `./mac-cleanup.sh --check` —— 确认体检通过、报告正常生成
2. 对比报告里的"实际释放"与你手动 `mo clean` 的经验值
3. 都正常再 `./install.sh`
4. 第一个季度跑完后，看一眼报告有没有出现"需要人看的情况"
