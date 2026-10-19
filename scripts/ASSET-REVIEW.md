# asset-review — 本地新资产审查

## 它做什么

```text
【事件】三个 Domain 目录一变 → launchd 立刻执行（FSEvents，不轮询）
        ↓
L1  比三个注册表的 sha256
        ↓  变了才继续（没变就 ~50ms 退出，把噪音挡掉）
L2  找出「新登记的资产」，对实现目录做机械扫描
        · 疑似密钥 / 令牌
        · shell: true / exec( 字符串（命令注入面）
        · 外部网络请求
        · 硬编码本机路径
        · README / .gitignore 是否存在
        · 实现目录是否存在
        ↓
L3  写一份报告，结尾附一段【可直接丢给 DSH 会话的审查指令】
    + 一条 macOS 通知（最严重发现级别 + 报告路径）
```

## 为什么是本地，不是 GitHub Actions

| | GitHub Actions | 本地（这个） |
|---|---|---|
| 触发时机 | push 之后 | **刚保存时** |
| 能看到未提交的改动 | ❌ | ✅ |
| 需要开机 | ❌ | ✅（但你在改代码时本来就在）|

**"最早发现"比"不需要开机"更值钱** —— 一个资产在写的时候被指出问题，改起来是几秒钟；等推上去再说，成本已经变成一次上下文切换。

而且它**不常驻、也不轮询**：launchd 用 FSEvents 盯着目录，有变动才起进程，跑完就退。

> ⚠️ **盯目录，不盯文件。** 编辑器用「写临时文件再改名」保存时（vim 默认如此），
> 被盯的文件 inode 会换掉，`WatchPaths` 从此**悄悄失效** —— 一个安静的死法。
> 盯目录不受影响；代价是任何文件变动都触发一次，所以脚本第一件事是比哈希，
> 没变就用 50ms 退出。

## 安装

```bash
bash scripts/install_asset_review.sh install
bash scripts/install_asset_review.sh status
```

## 手动跑

```bash
python3 scripts/asset_review.py            # 只看变化
python3 scripts/asset_review.py --all      # 全部重扫
python3 scripts/asset_review.py --quiet    # 不弹通知
ASSET_REVIEW_HOME=/tmp/x python3 scripts/asset_review.py   # 不碰真实状态
```

## 产物

```text
~/.ai-capability-store/asset-review/
  state.json              上次看到的注册表哈希 + 已知资产清单
  reports/<时间戳>.md      审查报告（保留最近 20 份）
  launchd.log             launchd 的运行日志
```

**都在仓库外** —— 它监控的是工作区，自己不能把工作区弄脏。

## 它能做什么，不能做什么

**能**：机械地找出所有「我看得出来」的问题，并且保证不漏（它每次都扫全文）。

**不能**：判断设计对不对。报告结尾那段指令就是为这一步准备的 —— 机械检查负责"有没有明显危险"，语义审查负责"该不该这么做"。

## 已知边界

- 只在**这台 Mac** 上生效。换机器要重新 install。
- **事件驱动**：保存后立刻触发，没有延迟。`ThrottleInterval` 30 秒是冷却，连续保存时不会每一下都起进程。
- 机械扫描正则基于这个仓库实际踩过的坑。**新类型的坑要加正则**，不会自己发现自己不知道的东西。
- `worst finding` 可能是误报（比如一个合法的 URL）。它给的是"值得看一眼"，不是"一定有问题"。
