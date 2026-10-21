# docs/

**这里放的是「解释性文档」，不是资产。**

| 目录 | 放什么 |
|---|---|
| `docs/known-issues/` | 外部依赖的已知问题（比如 DSH 的 UI bug）—— 会影响我们交付方式的那种 |

## 什么该放这里，什么不该

| 放这里 | 不放这里 |
|---|---|
| 跨域的解释（"为什么这套体系是这样"）| 单个资产怎么用 → 资产自己的 README |
| 外部依赖的坑（"这个工具坏了，绕一下"）| 域的结构与规则 → 各域的 README |
| 交接时对方必须先知道的背景 | 策略（AGENTS.md / CONTRIBUTING_AI.md / VERSIONING.md）|

**交接文档放在被交接的工作旁边**（例如 `orchestrations/scheduled-task/HANDOFF.md`），
而不是在这里 —— 因为读的人第一步就打开那个目录。
