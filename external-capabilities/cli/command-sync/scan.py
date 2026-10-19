#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
command-sync / scan.py —— 检测"新出现"的命令和服务器项目路径

目标（用户原话）：
    "只要有新增的，就帮我沉淀上来，并在上面扩充这个指令是干啥的。"

它做的事只有一件：**对比"现在的历史"和"已经沉淀过的快照"，把新增的挑出来。**
它不解释命令、不改文档 —— 解释和写入由 AI（或你）来做，脚本只负责"发现新增"。

用法：
    python3 scan.py commands            # 扫本机终端历史，看有没有新命令
    python3 scan.py commands --server   # 本机 + 服务器一起扫
    python3 scan.py server              # 扫服务器上的项目路径
    python3 scan.py commands --update   # 【仅在文档已更新后】把当前状态记为"已知"
    python3 scan.py server --update

设计原则：
    - 全程只读：不修改历史文件、不在服务器上写任何东西
    - 只报告"新增/消失"，不擅自改文档
    - 认不出命令行含义是正常的：它只报事实，含义由人来补

退出码：0 = 无新增；3 = 有新增（方便以后挂到自动任务里）
"""

import argparse
import collections
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# 运行时数据目录：默认 ~/.command-sync；可用环境变量 COMMAND_SYNC_HOME 覆盖（便于测试或整体搬家）
BASE = os.environ.get("COMMAND_SYNC_HOME") or os.path.join(os.path.expanduser("~"), ".command-sync")


def load_config():
    try:
        with open(os.path.join(BASE, "config.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


CONFIG = load_config()
KNOWN_CMDS = os.path.join(BASE, "known-commands.json")
KNOWN_PATHS = os.path.join(BASE, "known-server-paths.json")
KNOWN_PROGRAMS = os.path.join(BASE, "known-programs.json")
KNOWN_REPOS = os.path.join(BASE, "known-repos.json")
PENDING = os.path.join(BASE, "pending.md")


def clear_pending():
    """文档补齐后（执行 --update 时）清掉待沉淀清单。"""
    if os.path.exists(PENDING):
        os.remove(PENDING)
        print(f"🧹 待沉淀清单已清除（{os.path.basename(PENDING)}）")


def write_pending(scan_text, today):
    """把"发现的新增"写成一份给人看的待办清单，并附上可直接发给 AI 的话。"""
    with open(PENDING, "w", encoding="utf-8") as f:
        f.write(f"# 待沉淀清单（{today} 自动生成）\n\n")
        f.write("这些是**你终端里新出现、但文档里还没有**的东西。\n")
        f.write("等你有空时，把下面这句话直接发给 AI 就行：\n\n")
        f.write("> 请处理 command-sync 的待沉淀清单，核实后补进 git-commands.md / server-projects.md\n\n")
        f.write("---\n\n## 原始发现\n\n```\n")
        f.write(scan_text.rstrip())
        f.write("\n```\n")


def notify(title, message):
    """发一条 macOS 通知；失败也不影响任务本身。"""
    try:
        msg = message.replace('"', "'")
        subprocess.run(
            ["/usr/bin/osascript", "-e", f'display notification "{msg}" with title "{title}"'],
            capture_output=True, timeout=10,
        )
    except Exception:
        pass

LOCAL_HISTORY = os.path.expanduser("~/.zsh_history")
SSH_HOST = str(CONFIG.get("sshHost") or "").strip()
# 与 server-projects.md 里给你的那条命令完全一致（已实测）
PATH_SCAN_CMD = "find ~ /opt /srv /var/www -maxdepth 4 -name .git -type d 2>/dev/null | sed 's|/.git||'"

GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"}

# 管道 / 连接符之后的参数属于"另一条命令"，不能算作 git 的参数
SHELL_OPERATORS = ("|", "||", "&&", ";", ">", ">>", "<")


def strip_quotes(cmd):
    """把引号里的内容清空，避免把 "ssh -i 私钥" 里的参数当成 git 的参数。"""
    cmd = re.sub(r'"[^"]*"', '""', cmd)
    return re.sub(r"'[^']*'", "''", cmd)


def shell_head(cmd):
    """只取第一条命令（丢掉 | head -n 3 这种尾巴），避免把别人的参数算到 git 头上。"""
    cut = len(cmd)
    for op in SHELL_OPERATORS:
        i = cmd.find(op)
        if i != -1:
            cut = min(cut, i)
    return strip_quotes(cmd[:cut].strip())


# ---------------------------------------------------------------- 历史解析

def read_text(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def parse_entries(text):
    """把历史文件解析成"一条条命令"。

    规则：以 git 开头的行 = 一条命令；紧随其后且缩进的行 = 它的续行
    （你会一次粘贴多条命令，zsh 用 反斜杠+换行 编码，所以两者都要处理）
    """
    entries, buf = [], None
    for raw in text.split("\n"):
        line = re.sub(r"^: \d+:\d+;", "", raw)
        if re.match(r"^git\b", line):
            if buf is not None:
                entries.append(buf)
            buf = line.rstrip()
        elif buf is not None and line[:1] in (" ", "\t") and line.strip():
            buf = buf.rstrip("\\").rstrip() + " " + line.strip()
        else:
            if buf is not None:
                entries.append(buf)
                buf = None
    if buf is not None:
        entries.append(buf)
    return [re.sub(r"\s+", " ", e).rstrip("\\").strip() for e in entries]


def split_sub(cmd):
    """取出子命令，自动跳过 -C <路径> 这类全局参数。"""
    toks = shell_head(cmd).split()[1:]
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in GLOBAL_WITH_VALUE:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t
    return "(无子命令)"


def flags_of(cmd):
    """只保留从子命令之后出现的参数，用于做"用法签名"。"""
    toks = shell_head(cmd).split()[1:]
    i, seen_sub = 0, False
    flags = []
    while i < len(toks):
        t = toks[i]
        if not seen_sub:
            if t in GLOBAL_WITH_VALUE:
                i += 2
                continue
            if t.startswith("-"):
                i += 1
                continue
            seen_sub = True
            i += 1
            continue
        if t.startswith("-"):
            flags.append(t)
        i += 1
    return flags


# 这些子命令下面还有"子动作"（worktree add / stash push / remote set-url …），
# 不区分动作的话，"worktree add" 会被误判成已见过的"worktree"。
SUBACTION_SUBS = {"worktree", "stash", "remote", "submodule", "config", "bisect",
                  "reflog", "sparse-checkout", "notes", "maintenance"}


def action_of(cmd):
    """取出子命令之后的第一个"动作词"（非参数），没有就返回空。"""
    toks = shell_head(cmd).split()[1:]
    i, seen_sub = 0, False
    while i < len(toks):
        t = toks[i]
        if not seen_sub:
            if t in GLOBAL_WITH_VALUE:
                i += 2
                continue
            if t.startswith("-"):
                i += 1
                continue
            seen_sub = True
            i += 1
            continue
        if not t.startswith("-"):
            return t
        i += 1
    return ""


def mask(cmd):
    """脱敏 + 归一：把真实路径换成 <路径>，把字符串内容换成省略号"""
    s = re.sub(r"(/Users/[^\s\"']+|/home/[^\s\"']+|/opt/[^\s\"']+)", "<路径>", cmd)
    s = re.sub(r'"[^"]*"', '"…"', s)
    s = re.sub(r"'[^']*'", '"…"', s)
    return re.sub(r"\s+", " ", s).strip()


def signature(cmd):
    """用法签名 = [子动作] + 参数。用于判断"这条用法以前见过没有"。"""
    parts = []
    sub = split_sub(cmd)
    if sub in SUBACTION_SUBS:
        act = action_of(cmd)
        if act:
            parts.append(act)
    parts.extend(sorted(set(flags_of(cmd))))
    return " ".join(parts) if parts else "(无参数)"


# ---------------------------------------------------------------- 快照读写

def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")


# ---------------------------------------------------------------- 命令扫描

def collect(history_text, source):
    """从一份历史文本里统计 (子命令 -> 签名 -> {次数, 例子})"""
    stats = collections.defaultdict(lambda: collections.defaultdict(lambda: {"count": 0, "example": ""}))
    for cmd in parse_entries(history_text):
        sub = split_sub(cmd)
        sig = signature(cmd)
        rec = stats[sub][sig]
        rec["count"] += 1
        if not rec["example"]:
            rec["example"] = mask(cmd)
        rec["sources"] = sorted(set(rec.get("sources", []) + [source]))
    return stats


def cmd_scan(args):
    known = load_json(KNOWN_CMDS, {"subcommands": {}})
    known_subs = known.get("subcommands", {})

    sources = {"local": read_text(args.history)}
    if args.server:
        text = ssh_read("cat ~/.bash_history")
        if text is None:
            print("⚠️  无法读取服务器历史（ssh 失败），本次只扫了本机。", file=sys.stderr)
        else:
            sources["server"] = text

    merged = collections.defaultdict(lambda: collections.defaultdict(lambda: {"count": 0, "example": "", "sources": []}))
    for src, text in sources.items():
        for sub, sigs in collect(text, src).items():
            for sig, rec in sigs.items():
                m = merged[sub][sig]
                m["count"] += rec["count"]
                m["sources"] = sorted(set(m["sources"] + rec["sources"]))
                if not m["example"]:
                    m["example"] = rec["example"]

    new_subs, new_sigs, disappeared = [], [], []
    for sub, sigs in sorted(merged.items()):
        if sub not in known_subs:
            total = sum(r["count"] for r in sigs.values())
            ex = next(iter(sigs.values()))["example"]
            new_subs.append((sub, total, ex))
            continue
        old_sigs = known_subs[sub].get("signatures", {})
        for sig, rec in sigs.items():
            if sig not in old_sigs:
                new_sigs.append((sub, sig, rec["count"], rec["example"]))
    full_scan = os.path.abspath(args.history) == os.path.abspath(LOCAL_HISTORY)
    if full_scan:
        for sub in known_subs:
            if sub not in merged:
                disappeared.append(sub)

    print(f"扫描来源：{[f'{k}({len(v.splitlines())} 行)' for k, v in sources.items()]}")
    print(f"已知子命令：{len(known_subs)} 种 | 本次识别：{len(merged)} 种\n")

    if new_subs:
        print(f"🆕 新出现的命令（{len(new_subs)} 种）—— 需要补进文档并写明它是干啥的：")
        for sub, n, ex in new_subs:
            print(f"   • git {sub:<14} 出现 {n} 次   例：{ex}")
    if new_sigs:
        print(f"\n🔍 已有命令的新用法（{len(new_sigs)} 种）—— 建议在文档对应段落补一行：")
        for sub, sig, n, ex in new_sigs:
            print(f"   • git {sub} {sig:<22} 出现 {n} 次   例：{ex}")
    if disappeared:
        print(f"\nℹ️  快照里有、但当前历史已找不到（可能被清理过）：{', '.join(disappeared)}")
    if not (new_subs or new_sigs):
        print("✅ 没有新增。文档与你的历史一致。")

    if args.update:
        data = {"updated": args.today, "sources": sorted(sources), "subcommands": {}}
        for sub, sigs in sorted(merged.items()):
            data["subcommands"][sub] = {
                "count": sum(r["count"] for r in sigs.values()),
                "sources": sorted({s for r in sigs.values() for s in r["sources"]}),
                "signatures": {sig: {"count": r["count"], "example": r["example"]} for sig, r in sorted(sigs.items())},
            }
        save_json(KNOWN_CMDS, data)
        print(f"\n📝 已把当前状态写入 {os.path.basename(KNOWN_CMDS)}（此后它们算作'已知'）")
        clear_pending()

    return 3 if (new_subs or new_sigs) else 0


# ---------------------------------------------------------------- 服务器路径扫描

def ssh_read(remote_cmd, timeout=60):
    if not SSH_HOST:
        print("⚠️  未配置 sshHost，跳过服务器检查", file=sys.stderr)
        return None
    # 定时任务(launchd)环境下 PATH 很干净，所以优先用绝对路径
    ssh_bin = "/usr/bin/ssh" if os.path.exists("/usr/bin/ssh") else "ssh"
    try:
        p = subprocess.run(
            [ssh_bin, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SSH_HOST, remote_cmd],
            capture_output=True, text=True, timeout=timeout,
        )
    except Exception as e:
        print(f"⚠️  ssh 失败：{e}", file=sys.stderr)
        return None
    if p.returncode != 0:
        print(f"⚠️  ssh 返回码 {p.returncode}：{p.stderr.strip()}", file=sys.stderr)
        return None
    return p.stdout


def server_scan(args):
    known = load_json(KNOWN_PATHS, {"host": SSH_HOST, "paths": []})
    known_paths = list(known.get("paths", []))

    out = ssh_read(PATH_SCAN_CMD)
    if out is None:
        return 1
    now = sorted({l.strip() for l in out.split("\n") if l.strip()})
    known_set = set(known_paths)

    added = [p for p in now if p not in known_set]
    gone = [p for p in known_paths if p not in set(now)]

    print(f"服务器：{SSH_HOST}")
    print(f"已知项目：{len(known_paths)} 个 | 本次扫到：{len(now)} 个\n")
    print("当前所有项目：")
    for p in now:
        print(f"   {'🆕 ' if p in added else '   '}{p}")

    if added:
        print(f"\n🆕 新增项目（{len(added)} 个）—— 需要补进卡片：")
        for p in added:
            print(f"   • {p}")
    if gone:
        print(f"\n⚠️  已消失的项目（{len(gone)} 个）—— 卡片里该删或标注：")
        for p in gone:
            print(f"   • {p}")
    if not (added or gone):
        print("\n✅ 没有变化。卡片与服务器一致。")

    if args.update:
        info = {}
        for p in now:
            one = ssh_read(f'cd {p} 2>/dev/null && echo "$(git remote get-url origin 2>/dev/null)|$(git branch --show-current 2>/dev/null)"')
            remote, _, branch = (one or "|").strip().partition("|")
            info[p] = {"remote": remote.strip(), "branch": branch.strip()}
        save_json(KNOWN_PATHS, {"updated": args.today, "host": SSH_HOST, "paths": now, "detail": info})
        print(f"\n📝 已把当前状态写入 {os.path.basename(KNOWN_PATHS)}")
        clear_pending()

    return 3 if (added or gone) else 0


# ---------------------------------------------------------------- 一键检查

def all_scan(args):
    """把所有线一次跑完，并生成一份带日期的报告（给定时任务用）。"""
    import io
    from datetime import datetime

    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        rc1 = cmd_scan(argparse.Namespace(history=args.history, server=True, update=False, today=args.today))
        print("\n" + "-" * 60 + "\n")
        rc2 = program_scan(argparse.Namespace(history=args.history, server=True, update=False, today=args.today))
        print("\n" + "-" * 60 + "\n")
        rc3 = server_scan(argparse.Namespace(update=False, today=args.today))
        print("\n" + "-" * 60 + "\n")
        rc4 = repo_scan(argparse.Namespace(update=False, today=args.today))
    finally:
        sys.stdout = old

    text = buf.getvalue()
    print(text)

    reports = os.path.join(BASE, "reports")
    os.makedirs(reports, exist_ok=True)
    path = os.path.join(reports, f"{args.today}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"# 同步检查报告 {args.today}\n\n")
        f.write(f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")
        f.write("```\n" + text.rstrip() + "\n```\n")

    has_new = 3 in (rc1, rc2, rc3, rc4)
    if has_new:
        write_pending(text, args.today)
        notify("command-sync 发现变化", "有新命令/新项目/上游仓库变化，详见 pending.md")
        print(f"📌 已生成待沉淀清单：{os.path.basename(PENDING)}")
    print(f"本次结论：{'⚠️ 有变化，需要处理' if has_new else '✅ 无变化'}")
    print(f"报告已保存：reports/{args.today}.md")
    return 3 if has_new else 0


# ---------------------------------------------------------------- 文档一致性自检

def doc_verify(args):
    """检查"快照记录的内容"是否都写进了文档 —— 防止"发现了却没沉淀"。

    这是这套机制最容易出问题的地方：脚本知道 27 种命令，文档却只写了 23 种。
    """
    problems = []

    known = load_json(KNOWN_CMDS, {"subcommands": {}})
    subs = known.get("subcommands", {})
    git_doc_path = os.path.join(BASE, "git-commands.md")
    if os.path.exists(git_doc_path):
        git_doc = read_text(git_doc_path)
    else:
        git_doc, _ = "", problems.append(("缺失文件", "git-commands.md"))

    for sub in sorted(subs):
        needle = "git --version" if sub == "(无子命令)" else f"git {sub}"
        if needle not in git_doc:
            problems.append(("git-commands.md 未收录", needle))

    kp = load_json(KNOWN_PATHS, {"paths": []})
    paths = kp.get("paths", [])
    sp_doc_path = os.path.join(BASE, "server-projects.md")
    if os.path.exists(sp_doc_path):
        sp_doc = read_text(sp_doc_path)
    else:
        sp_doc, _ = "", problems.append(("缺失文件", "server-projects.md"))

    for p in paths:
        if p not in sp_doc:
            problems.append(("server-projects.md 未收录", p))

    # 非 git 程序 → 必须写进 other-commands.md（git 自己在 git-commands.md 里）
    kpr = load_json(KNOWN_PROGRAMS, {"programs": {}})
    progs = [p for p, r in kpr.get("programs", {}).items()
             if not p.startswith("git") and worth_documenting(p, r.get("count", 0))]
    oc_doc_path = os.path.join(BASE, "other-commands.md")
    if progs:
        if os.path.exists(oc_doc_path):
            oc_doc = read_text(oc_doc_path)
        else:
            oc_doc, _ = "", problems.append(("缺失文件", "other-commands.md"))
        for p in sorted(progs):
            if p not in oc_doc:
                problems.append(("other-commands.md 未收录", p))

    # 联动巡检：部署中的仓库若上游已归档/删除，算不一致（需要处置）
    kr = load_json(KNOWN_REPOS, {"repos": {}})
    stale_repos = [s for s, v in kr.get("repos", {}).items() if v.get("status") != "活跃"]
    for s in sorted(stale_repos):
        problems.append(("上游已归档/删除但仍在卡片中", s))

    print(f"一致性自检：git 命令 {len(subs)} 项 / 非 git 程序 {len(progs)} 项 / 服务器路径 {len(paths)} 项 / 部署仓库 {len(kr.get('repos', {}))} 项")
    if problems:
        print(f"\n⚠️  发现 {len(problems)} 处不一致 —— 有东西已进快照、却没写进文档：")
        for kind, item in problems:
            print(f"   • [{kind}] {item}")
        print("\n处理办法：把这些补进对应文档，完成后本项自检即可通过。")
        return 4
    print("\n✅ 文档与快照完全一致：没有漏沉淀，也没有多出来的。")
    return 0


# ---------------------------------------------------------------- 全命令扫描（不限 git）

SHELL_KEYWORDS = {"then", "fi", "do", "done", "else", "elif", "if", "for", "while",
                  "until", "esac", "case", "in", "function", "}", "{"}

# 只认得"像程序名"的 token，避免把粘贴进来的代码碎片（print("") / ) / import …）当成命令
PROGRAM_RE = re.compile(r"^[A-Za-z0-9._][A-Za-z0-9._-]*(?: [A-Za-z0-9._-]+)?$")

# 这些虽然常用，但没有"解释价值"，不要求写进文档
DOC_NOISE = {"echo", "export", "source", "set", "command", "EOF", "PY", "import",
             "from", "text", "const", "auth0", "codex", "true", "false", ":"}

# 出现次数达到这个门槛，才认为"值得沉淀并解释"
DOC_THRESHOLD = 15


def parse_any_entries(text):
    """和 parse_entries 相同，但接受任意命令（不只 git）。"""
    entries, buf = [], None
    for raw in text.split("\n"):
        line = re.sub(r"^: \d+:\d+;", "", raw)
        if re.match(r"^[^\s#]", line):
            if buf is not None:
                entries.append(buf)
            buf = line.rstrip()
        elif buf is not None and line[:1] in (" ", "\t") and line.strip():
            buf = buf.rstrip("\\").rstrip() + " " + line.strip()
        else:
            if buf is not None:
                entries.append(buf)
                buf = None
    if buf is not None:
        entries.append(buf)
    return [re.sub(r"\s+", " ", e).rstrip("\\").strip() for e in entries]


def program_of(cmd):
    """取"这条命令用的是哪个程序"。sudo 会带上它提权执行的那个程序。"""
    toks = shell_head(cmd).split()
    if not toks:
        return ""
    while toks and (toks[0] in ("time", "!") or toks[0].startswith("!")):
        toks = toks[1:]
    if not toks:
        return ""
    p = toks[0]
    if p in ("sudo", "doas") and len(toks) > 1 and not toks[1].startswith("-"):
        p = f"{p} {os.path.basename(toks[1])}"
    p = os.path.basename(p)
    if p in SHELL_KEYWORDS or not PROGRAM_RE.match(p):
        return ""
    return p


def worth_documenting(prog, count):
    """这个程序是否"值得写进说明书"：够高频、且不是噪音。"""
    return count >= DOC_THRESHOLD and prog not in DOC_NOISE


def program_scan(args):
    """统计你用过的所有命令（按程序分组），列出还没沉淀的新程序。"""
    known = load_json(KNOWN_PROGRAMS, {"programs": {}})
    known_progs = known.get("programs", {})

    sources = {"local": read_text(args.history)}
    if args.server:
        text = ssh_read("cat ~/.bash_history")
        if text is not None:
            sources["server"] = text

    counts = collections.defaultdict(lambda: {"count": 0, "example": "", "sources": []})
    total = 0
    for src, text in sources.items():
        for cmd in parse_any_entries(text):
            prog = program_of(cmd)
            if not prog:
                continue
            total += 1
            rec = counts[prog]
            rec["count"] += 1
            if not rec["example"]:
                rec["example"] = mask(cmd)
            if src not in rec["sources"]:
                rec["sources"].append(src)

    new = {p: r for p, r in counts.items()
           if p not in known_progs and worth_documenting(p, r["count"])}

    print(f"扫描来源：{[f'{k}({len(v.splitlines())} 行)' for k, v in sources.items()]}")
    print(f"命令条目：{total} 条 | 用到 {len(counts)} 种程序 | 已沉淀 {len(known_progs)} 种\n")
    print("你用得最多的程序：")
    for p, r in sorted(counts.items(), key=lambda x: -x[1]["count"])[:12]:
        mark = " " if p in known_progs else "🆕"
        print(f"   {mark} {p:<18} {r['count']:>4} 次   例：{r['example'][:64]}")

    if new:
        print(f"\n🆕 还没沉淀的新程序（{len(new)} 种）：")
        for p, r in sorted(new.items(), key=lambda x: -x[1]["count"]):
            print(f"   • {p:<18} {r['count']:>4} 次   例：{r['example'][:64]}")
    else:
        print("\n✅ 没有新程序。")

    if args.update:
        save_json(KNOWN_PROGRAMS, {"updated": args.today, "sources": sorted(sources), "programs": counts})
        print(f"\n📝 已把当前状态写入 {os.path.basename(KNOWN_PROGRAMS)}")
        clear_pending()

    return 3 if new else 0


# ---------------------------------------------------------------- GitHub × 服务器 联动巡检

def gh(*args_list, timeout=90):
    gh_bin = "/opt/homebrew/bin/gh" if os.path.exists("/opt/homebrew/bin/gh") else "gh"
    try:
        p = subprocess.run([gh_bin] + list(args_list), capture_output=True, text=True, timeout=timeout)
    except Exception as e:
        print(f"⚠️  gh 调用失败：{e}", file=sys.stderr)
        return None
    if p.returncode != 0:
        print(f"⚠️  gh 返回 {p.returncode}：{p.stderr.strip()[:160]}", file=sys.stderr)
        return None
    return p.stdout


def repo_slug_from_remote(url):
    """从 git remote 地址里取出 owner/repo。"""
    if not url:
        return ""
    m = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?$", url.strip())
    return f"{m.group(1)}/{m.group(2)}" if m else ""


def repo_scan(args):
    """巡检：服务器上部署的项目，它们的 GitHub 仓库现在是什么状态。"""
    owner = "LyraWang6688"
    out = gh("repo", "list", owner, "--limit", "200", "--json", "name,isArchived,visibility,pushedAt")
    if out is None:
        return 1
    repos = {f"{owner}/{r['name']}": r for r in json.loads(out)}

    paths = load_json(KNOWN_PATHS, {"paths": [], "detail": {}})
    deployed = {}
    for path, d in (paths.get("detail") or {}).items():
        slug = repo_slug_from_remote(d.get("remote", ""))
        if slug:
            deployed[slug] = path

    known = load_json(KNOWN_REPOS, {"repos": {}})
    known_repos = known.get("repos", {})

    problems, changes = [], []
    for slug, path in sorted(deployed.items()):
        st = "活跃"
        if slug in repos:
            st = "已归档" if repos[slug]["isArchived"] else "活跃"
        else:
            # 不在自己名下 → 可能是别人的仓库，也可能是被删了
            one = gh("api", f"repos/{slug}", "--jq", ".archived")
            if one is None:
                st = "已删除/不可访问"
            else:
                st = "已归档" if one.strip() == "true" else "活跃"
        if st != "活跃":
            problems.append((slug, path, st))
        old = known_repos.get(slug, {}).get("status")
        if old and old != st:
            changes.append((slug, old, st))
        known_repos[slug] = {"status": st, "path": path, "checked": args.today}

    print(f"巡检范围：服务器上部署的 {len(deployed)} 个仓库（GitHub 名下共 {len(repos)} 个仓库）\n")
    print("部署中的项目 → 上游仓库状态：")
    for slug, path in sorted(deployed.items()):
        st = known_repos[slug]["status"]
        icon = {"活跃": "✅", "已归档": "📦", "已删除/不可访问": "❌"}.get(st, "?")
        print(f"   {icon} {slug:<42} {st:<12} ← {path}")

    if problems:
        print(f"\n🚨 需要处置（{len(problems)} 个）：上游已归档或删除，服务器上还部署着 ——")
        print("   建议：停进程 → 删目录 → 摘 Nginx 站点（与 2026-10-04 那次清理同样的流程）")
    if changes:
        print(f"\n🔄 与上次巡检相比发生变化（{len(changes)} 个）：")
        for slug, old, new in changes:
            print(f"   • {slug}：{old} → {new}")
    if not (problems or changes):
        print("\n✅ 没有异常：部署中的项目，上游仓库都还活跃。")

    if args.update:
        save_json(KNOWN_REPOS, {"updated": args.today, "owner": owner, "repos": known_repos})
        print(f"\n📝 已把当前状态写入 {os.path.basename(KNOWN_REPOS)}")

    return 3 if (problems or changes) else 0


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="检测新增的终端命令与服务器项目路径（只读）")
    sub = ap.add_subparsers(dest="mode", required=True)

    c = sub.add_parser("commands", help="扫描终端历史里的 git 命令")
    c.add_argument("--history", default=LOCAL_HISTORY, help="历史文件路径（默认 ~/.zsh_history）")
    c.add_argument("--server", action="store_true", help="同时扫描服务器上的 bash 历史")
    c.add_argument("--update", action="store_true", help="把当前状态记为已知")
    c.add_argument("--today", default="", help="写入快照时记录的日期")
    c.set_defaults(func=cmd_scan)

    s = sub.add_parser("server", help="扫描服务器上的项目路径")
    s.add_argument("--update", action="store_true", help="把当前状态记为已知")
    s.add_argument("--today", default="", help="写入快照时记录的日期")
    s.set_defaults(func=server_scan)

    a = sub.add_parser("all", help="一次跑完所有线并生成报告（给定时任务用）")
    a.add_argument("--history", default=LOCAL_HISTORY, help="历史文件路径（默认 ~/.zsh_history）")
    a.add_argument("--today", default="", help="报告文件名所用的日期")
    a.set_defaults(func=all_scan)

    v = sub.add_parser("verify", help="自检：快照里的内容是否都已写进文档")
    v.add_argument("--today", default="", help="（占位，保持接口一致）")
    v.set_defaults(func=doc_verify)

    pr = sub.add_parser("programs", help="扫描你用过的所有命令（不限 git），按程序分组")
    pr.add_argument("--history", default=LOCAL_HISTORY, help="历史文件路径（默认 ~/.zsh_history）")
    pr.add_argument("--server", action="store_true", help="同时扫描服务器上的 bash 历史")
    pr.add_argument("--update", action="store_true", help="把当前状态记为已知")
    pr.add_argument("--today", default="", help="写入快照时记录的日期")
    pr.set_defaults(func=program_scan)

    rp = sub.add_parser("repos", help="联动巡检：服务器上的项目，其 GitHub 仓库是否已归档/删除")
    rp.add_argument("--update", action="store_true", help="把当前状态记为已知")
    rp.add_argument("--today", default="", help="写入快照时记录的日期")
    rp.set_defaults(func=repo_scan)

    args = ap.parse_args()
    if not args.today:
        from datetime import date
        args.today = date.today().isoformat()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
