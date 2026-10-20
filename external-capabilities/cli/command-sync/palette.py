#!/usr/bin/env python3
"""命令面板数据生成器：把 ~/.zsh_history 里高频 + 最近的命令，和服务器项目入口命令，
整理成 ~/.command-sync/palette.json，供 Hammerspoon 面板（⌥X）读取。

只读历史，不执行任何命令。
"""
import datetime
import glob
import json
import os
import re
import sys

HOME = os.path.expanduser("~")
BASE = os.environ.get("COMMAND_SYNC_HOME") or os.path.join(HOME, ".command-sync")
CONFIG_PATH = os.path.join(BASE, "config.json")
DEFAULT_HISTORY = os.path.join(HOME, ".zsh_history")


def load_config():
    try:
        return json.load(open(CONFIG_PATH, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


CONFIG = load_config()
HISTORY = os.path.expanduser(CONFIG.get("history") or DEFAULT_HISTORY)
DUMP_GLOB = os.path.join(BASE, "history-dump*.txt")
OUT = os.path.join(BASE, "palette.json")
SERVER_PATHS = os.path.join(BASE, "known-server-paths.json")
SHORTCUTS = os.path.join(BASE, "shortcuts.md")
HAMMERSPOON_DIR = os.path.join(HOME, ".hammerspoon")
SSH_CONFIG = os.path.join(HOME, ".ssh", "config")

SKIP_EXACT = {"ls", "cd", "pwd", "clear", "exit", "history", "ll", "la", "q", "vi", "vim", "nano", "top", "htop",
              "PY", "EOF", "END", "JSON"}
SENSITIVE = re.compile(r"(token|password|passwd|secret|api[_-]?key|--password|--token)", re.I)


def parse_history(text):
    """zsh history -> list of (command, epoch|None), order preserved.

    Supports both plain lines and extended `: <epoch>:<duration>;command` form,
    including backslash-continued multi-line entries.
    """
    commands = []
    buf = None
    for raw in text.split("\n"):
        epoch = None
        m = re.match(r"^: (\d+):\d+;", raw)
        if m:
            epoch = int(m.group(1))
        # `fc -l` dump form: "  123  command"
        numbered = re.match(r"^\s*\d+\s+(.*)$", raw)
        if numbered:
            raw = numbered.group(1)
        line = re.sub(r"^: \d+:\d+;", "", raw)
        # continuation: previous command ended with a backslash
        if buf is not None:
            if line[:1] in (" ", "\t") or raw.endswith("\\") or line.endswith("\\"):
                buf = buf.rstrip("\\").rstrip() + " " + line.strip()
                if not line.endswith("\\"):
                    commands.append((re.sub(r"\s+", " ", buf).strip(), epoch))
                    buf = None
                continue
            commands.append((re.sub(r"\s+", " ", buf).strip(), epoch))
            buf = None
        if not line.strip():
            continue
        if line.endswith("\\"):
            buf = line
        else:
            commands.append((re.sub(r"\s+", " ", line).strip(), epoch))
    if buf:
        commands.append((re.sub(r"\s+", " ", buf).strip(), None))
    return commands


def ns(text):
    """strip zsh extended timestamp prefix (defensive)."""
    return re.sub(r"^: \d+:\d+;", "", text)


def useful(cmd):
    c = ns(cmd).strip()
    if len(c) < 2:
        return False
    if SENSITIVE.search(c):
        return False
    head = c.split()[0]
    if c in SKIP_EXACT or head in {"cd"}:
        return False
    if c.startswith("#"):
        return False
    # heredoc / here-string fragments are not reusable commands
    if "<<" in c or "EOF" in c or "PY" == c or "JSON" == c:
        return False
    # environment wiring is not a reusable action
    if head in {"export", "set", "unset"} or "PATH=" in c or c.startswith("source ") and " " in c[7:]:
        return False
    # pasted terminal transcripts / prompts are not commands
    if " % " in c or c.startswith("wangying@") or "Last login" in c or c.startswith("$ "):
        return False
    # leftover multi-line paste encoding
    if "\\n" in c:
        return False
    # bare IP / port fragments
    if re.fullmatch(r"[0-9.:\-]+", c):
        return False
    return True


def build_local(command_sets, limit=5):
    """command_sets: list of per-source command lists (each list ordered oldest->newest).

    The same shell session often appears in both ~/.zsh_history and an `fc -l`
    dump, so counts are merged with `max` (not summed) to avoid double counting.
    """
    stats = {}
    total = max((len(c) for c in command_sets), default=1)
    now = datetime.datetime.now().timestamp()
    for commands in command_sets:
        for idx, pair in enumerate(commands):
            raw, epoch = pair if isinstance(pair, tuple) else (pair, None)
            cmd = ns(raw).strip()
            if not useful(cmd):
                continue
            rec = stats.setdefault(cmd, {"command": cmd, "count": 0, "last_epoch": None, "last_index": 0})
            rec["count"] = max(rec["count"], 0) + 1 if rec["count"] == 0 else rec["count"]
            # count per source, merged by max below
            rec.setdefault("per_source", {})
            rec["per_source"][id(commands)] = rec["per_source"].get(id(commands), 0) + 1
            rec["last_index"] = max(rec["last_index"], idx)
            if epoch:
                rec["last_epoch"] = max(rec["last_epoch"] or 0, epoch)
    for rec in stats.values():
        rec["count"] = max(rec["per_source"].values()) if rec.get("per_source") else 1
    items = list(stats.values())

    def score(r):
        s = r["count"] * 2 + (r["last_index"] / total) * 5
        if r["last_epoch"]:
            days = max((now - r["last_epoch"]) / 86400, 0)
            s += 12 / (1 + days / 7)      # 7 天内使用的加分明显
        return s

    for r in items:
        if r["last_epoch"]:
            r["last_used"] = datetime.datetime.fromtimestamp(r["last_epoch"]).strftime("%m-%d %H:%M")
        else:
            r["last_used"] = "未知时间"
    items.sort(key=score, reverse=True)
    out = []
    for r in items:
        if len(out) >= limit:
            break
        if r["count"] < 2:
            continue
        out.append({
            "kind": "local",
            "title": r["command"][:120],
            "command": r["command"],
            "count": r["count"],
            "last": r["last_used"],
        })
    return out


def ssh_target():
    host, user = None, "ubuntu"
    try:
        lines = open(SSH_CONFIG, encoding="utf-8").read().splitlines()
        for line in lines:
            s = line.strip()
            m = re.match(r"^HostName\s+(\S+)$", s, re.I)
            if m and not host:
                host = m.group(1)
            m = re.match(r"^User\s+(\S+)$", s, re.I)
            if m:
                user = m.group(1)
    except OSError:
        pass
    return user, host


def build_recent_week(command_sets, limit=5, days=7):
    """最近 N 天内用得最多的本地命令；不足 limit 时用最近的命令补齐。"""
    now = datetime.datetime.now().timestamp()
    cutoff = now - days * 86400

    counts = {}
    fallback = []
    seen = set()
    merged = [pair for commands in command_sets for pair in commands]
    for idx, pair in enumerate(merged):
        raw, epoch = pair
        cmd = ns(raw).strip()
        if not useful(cmd):
            continue
        if epoch and epoch >= cutoff:
            rec = counts.setdefault(cmd, {"command": cmd, "count": 0, "last_epoch": 0})
            rec["count"] += 1
            rec["last_epoch"] = max(rec["last_epoch"], epoch)
    in_window = sorted(counts.values(), key=lambda r: (r["count"], r["last_epoch"]), reverse=True)

    out = []
    for rec in in_window[:limit]:
        seen.add(rec["command"])
        out.append({
            "kind": "recent",
            "title": rec["command"][:120],
            "command": rec["command"],
            "count": rec["count"],
            "last": datetime.datetime.fromtimestamp(rec["last_epoch"]).strftime("%m-%d %H:%M"),
        })

    # fallback: newest commands from history (old entries have no timestamp)
    for raw, epoch in reversed(merged):
        if len(out) >= limit:
            break
        cmd = ns(raw).strip()
        if not useful(cmd) or cmd in seen:
            continue
        seen.add(cmd)
        out.append({
            "kind": "recent",
            "title": cmd[:120],
            "command": cmd,
            "count": 0,
            "last": "旧记录",
        })
    return out


# ── 快捷键速查 ─────────────────────────────────────────────────────────────
#
# 两类数据：
#   1. ~/.command-sync/shortcuts.json —— 手动维护。系统快捷键（Finder 的 ⌘⇧.）
#      和第三方 App 的快捷键没法自动发现，只能写进来。
#   2. ~/.hammerspoon/*.lua —— 自动扫 hs.hotkey.bind。能拿到组合键和函数名，
#      拿不到"这是干什么的"。
#
# 扫到但 shortcuts.json 里没有的，标成「未登记」原样列出 —— 否则新加的快捷键
# 永远不会出现在面板里，而面板的意义就是"记不住的时候有个地方找"。

MOD_SYMBOLS = {"alt": "⌥", "option": "⌥", "ctrl": "⌃", "control": "⌃",
               "cmd": "⌘", "command": "⌘", "shift": "⇧"}


def combo_from_bind(mods, key):
    """把 hs.hotkey.bind({"alt"}, "x", fn) 的实参拼成 ⌥X。"""
    parts = []
    for m in mods:
        sym = MOD_SYMBOLS.get(m.strip().strip('"').strip("'").lower())
        if sym:
            parts.append(sym)
    return "".join(parts) + (key.strip().strip('"').strip("'").upper() or "?")


def scan_hammerspoon():
    """扫 ~/.hammerspoon 下的 hs.hotkey.bind，返回 [{"combo": ..., "fn": ...}]。"""
    found = []
    if not os.path.isdir(HAMMERSPOON_DIR):
        return found
    bind = re.compile(
        r'''hs\.hotkey\.bind\(\s*\{([^}]*)\}\s*,\s*["']([^"']+)["']\s*,\s*([A-Za-z_][\w.]*)''')
    for name in sorted(os.listdir(HAMMERSPOON_DIR)):
        if not name.endswith(".lua"):
            continue
        try:
            with open(os.path.join(HAMMERSPOON_DIR, name), encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except OSError:
            continue
        for hit in bind.finditer(text):
            mods = [x for x in hit.group(1).split(",") if x.strip()]
            found.append({"combo": combo_from_bind(mods, hit.group(2)),
                          "fn": hit.group(3), "file": name})

    return found


def load_shortcuts():
    """一行一条。插件（selection-toolbar）往这里追加，面板读它。

    用纯文本而不是 JSON：两个组件各写各的字段格式就会漂移，而这个文件的
    全部职责就是"记住一句话" —— 让人也能直接编辑它。
    """
    try:
        with open(SHORTCUTS, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return []
    rows = []
    for line in raw.splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        if text.startswith("- "):
            text = text[2:].strip()
        rows.append(text)
    return rows


def build_shortcuts():
    """速查表：手存的在前（有描述），扫出来但没登记的在后（标 ⚠️）。"""
    saved = load_shortcuts()
    items = [{
        "kind": "shortcut",
        "title": line,
        "command": line,
        "shortcut": line,
        "count": 0,
        "last": "已保存",
    } for line in saved]

    norm = lambda x: re.sub(r"\s+", "", x).lower()
    seen = {norm(x) for x in saved}
    for hit in scan_hammerspoon():
        # 已经手存过的跳过（比较去掉空格、忽略大小写）
        if any(norm(hit["combo"]) in norm(x) for x in saved):
            continue
        items.append({
            "kind": "shortcut",
            "title": "⚠️ 未登记：" + hit["fn"],
            "command": hit["combo"],
            "shortcut": hit["combo"],
            "count": 0,
            "last": "Hammerspoon",
        })
    return items


def build_server():
    out = []
    cfg_user = str(CONFIG.get("sshUser") or "").strip()
    cfg_host = str(CONFIG.get("sshHost") or "").strip()
    if cfg_host:
        user, host = (cfg_user or "ubuntu"), cfg_host
    else:
        user, host = ssh_target()
    if not host:
        return out
    out.append({
        "kind": "server",
        "title": "ssh 登录服务器 %s@%s" % (user, host),
        "command": "ssh %s@%s" % (user, host),
        "count": 0,
        "last": "服务器",
    })
    paths = list(CONFIG.get("serverPaths") or [])
    detail = {}
    try:
        data = json.load(open(SERVER_PATHS, encoding="utf-8"))
        if not paths:
            paths = data.get("paths") or []
        detail = data.get("detail") or {}
    except OSError:
        pass
    for path in paths:
        info = detail.get(path) or {}
        name = info.get("remote", "").split("/")[-1].replace(".git", "")
        label = path
        if name and name != path:
            label = "%s（%s）" % (path, name)
        out.append({
            "kind": "server",
            "title": "进入服务器项目 %s" % label,
            "command": "ssh -t %s@%s 'cd %s && exec bash -l'" % (user, host, path),
            "count": 0,
            "last": "服务器项目",
        })
    return out


def main():
    try:
        text = open(HISTORY, encoding="utf-8", errors="replace").read()
    except OSError as exc:
        print("读取历史失败：%s" % exc, file=sys.stderr)
        return 1
    paths = sorted(glob.glob(DUMP_GLOB)) + [HISTORY]
    command_sets = []
    seen_sources = []
    for path in paths:
        try:
            command_sets.append(parse_history(open(path, encoding="utf-8", errors="replace").read()))
            seen_sources.append(os.path.basename(path))
        except OSError:
            continue
    commands = [pair for commands_in_source in command_sets for pair in commands_in_source]
    payload = {
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "history_lines": len(commands),
        "sources": seen_sources,
        "items": build_server() + build_shortcuts() + build_recent_week(command_sets),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("已生成 %s（%d 条）" % (OUT, len(payload["items"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
