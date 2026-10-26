# readloop-replay-eval

在本地跑 ReadLoop 的规则回放评估（SM-2 vs FSRS），不依赖服务器、不需要部署。

## 跑什么

```bash
node procedures/readloop-replay-eval/run.mjs
# 传参：--days 84 --cards 80 --seed 42 等（原样转给 replay-compare.ts）
node procedures/readloop-replay-eval/run.mjs -- --practice /path/to/practice.json
```

步骤：

1. 找一份 ReadLoop 服务仓库：`--repo <路径>` 或自动 `git clone --depth 1` 到临时目录
2. 用 `npx tsx` 跑 `scripts/replay-compare.ts`
3. 打印对比结果；临时目录用完即删（`--keep` 可保留）

## 前提

- Node.js ≥ 18、git、能访问 GitHub / npm（`npx` 首次会下载 tsx）
- 真实日志回放需要导出 `practice_events`（含 `复习间隔` 字段），见服务仓库 `docs/EVALUATION.md`

## 为什么 clone 而不是复制代码

评估要用服务仓库里的 `src/lib/*`（scheduler / metrics / replay）。复制进 Store 会造成两份算法，
改一处忘一处。这里每次取最新代码，只保留一份实现。

## 自测

```bash
node procedures/readloop-replay-eval/run.mjs --self-test
```
