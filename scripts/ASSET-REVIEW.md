# asset-review — 本地新资产审查

## 它做什么

```text
L1  每 5 分钟比一次三个注册表的 sha256
        ↓  变了才继续（没变就静默退出，不打扰）
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

而且它**不常驻**：launchd 每 5 分钟起一次，跑完就退。没有守护进程，没有东西会忘了关。

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
- `StartInterval` 是 5 分钟：**保存后最多 5 分钟才有反应**。要更快就调小，但意义不大 —— 你改完一个资产通常在同一个文件里待不止 5 分钟。
- 机械扫描正则基于这个仓库实际踩过的坑。**新类型的坑要加正则**，不会自己发现自己不知道的东西。
- `worst finding` 可能是误报（比如一个合法的 URL）。它给的是"值得看一眼"，不是"一定有问题"。
