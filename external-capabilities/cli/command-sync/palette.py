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


def build_recent(command_sets, limit=5):
    """Newest unique commands: timestamped entries first, then latest index."""
    if not command_sets:
        return []
    merged = []
    for commands in command_sets:
        merged.extend(commands)
    indexed = []
    for idx, (raw, epoch) in enumerate(merged):
        indexed.append((idx, raw, epoch))
    indexed.sort(key=lambda item: (item[2] or 0, item[0]), reverse=True)
    seen = set()
    out = []
    for _idx, raw, epoch in indexed:
        cmd = ns(raw).strip()
        if not useful(cmd) or cmd in seen:
            continue
        seen.add(cmd)
        out.append({
            "kind": "recent",
            "title": cmd[:120],
            "command": cmd,
            "count": 0,
            "last": "最近用过",
        })
        if len(out) >= limit:
            break
    return out


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
        name = info.get("remote", "").split("/")[-1].replace(".git", "") or path
        out.append({
            "kind": "server",
            "title": "进入服务器项目 %s（%s）" % (path, name),
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
        "items": build_server() + build_recent(command_sets) + build_local(command_sets),
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("已生成 %s（%d 条）" % (OUT, len(payload["items"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
