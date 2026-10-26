# readloop-license-issue

本地生成 ReadLoop 授权码（8 位，按年有效）。不联网、不上传、不碰服务器。

## 跑什么

```bash
LICENSE_SECRET=<生产密钥> node procedures/readloop-license-issue/run.mjs 10
# 或
LICENSE_SECRET=<生产密钥> node procedures/readloop-license-issue/run.mjs --count 10
# 复用已有仓库（避免每次 clone）
LICENSE_SECRET=<生产密钥> node procedures/readloop-license-issue/run.mjs --repo /path/to/ReadLoop 10
```

## 前提

- Node.js ≥ 18、git；`LICENSE_SECRET` 必须与线上服务一致（换密钥会让旧码全部失效）
- 首次运行会 `git clone --depth 1` 服务仓库并用 `npx tsx` 跑 `scripts/license-gen.ts`（需要网络）

## 安全

- 输出的是**真实可用授权码**：不要贴到公开渠道、不要提交进仓库
- 密钥只从环境变量读取，不写入任何文件

## 自测

```bash
node procedures/readloop-license-issue/run.mjs --self-test
```
