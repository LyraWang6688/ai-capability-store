#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读 deepseek-invoice 最近一次 run-*.log，提取摘要并投递到任务收件箱。

日志不是今天的则跳过（说明今天没跑）。
"""
import datetime, glob, json, os, re, subprocess, sys

LOG_DIR = os.environ.get("DEEPSEEK_INVOICE_LOG_DIR", "/opt/deepseek-invoice/logs")
DELIVER = os.environ.get("DSH_INBOX_DELIVER", "/srv/dsh-jobs/scripts/inbox-deliver")

STATE_DIR = os.environ.get("DSH_INBOX_STATE_DIR", "/srv/dsh-jobs/state")

def already_delivered(task):
    path = os.path.join(STATE_DIR, task + ".delivered")
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip() == datetime.date.today().isoformat()
    except OSError:
        return False

def mark_delivered(task):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(os.path.join(STATE_DIR, task + ".delivered"), "w", encoding="utf-8") as fh:
            fh.write(datetime.date.today().isoformat())
    except OSError:
        pass

UNIT = os.environ.get("DEEPSEEK_INVOICE_UNIT", "deepseek-invoice.service")

def latest_log():
    files = sorted(glob.glob(os.path.join(LOG_DIR, "run-*.log")))
    return files[-1] if files else None

def service_status():
    res = subprocess.run(["systemctl", "show", UNIT, "-p", "ExecMainStatus", "-p", "Result"],
                         capture_output=True, text=True)
    out = dict(line.split("=", 1) for line in res.stdout.strip().splitlines() if "=" in line)
    return out.get("ExecMainStatus", ""), out.get("Result", "")

def main():
    force = "--force" in sys.argv
    path = latest_log()
    if path is None:
        print(json.dumps({"ok": False, "message": "no invoice run log found"}, ensure_ascii=False))
        return 0
    mtime = datetime.date.fromtimestamp(os.path.getmtime(path))
    if not force and mtime != datetime.date.today():
        print(json.dumps({"ok": True, "skipped": "log is not today's", "log": path}, ensure_ascii=False))
        return 0

    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    code, state = service_status()
    if state == "timeout":
        result = "超时"
    elif code == "0":
        result = "成功"
    elif code == "":
        result = "成功"
    else:
        result = "失败"

    lines = [l for l in text.splitlines() if l.strip()]
    picked = []
    for key in ("可开票金额", "本月无可开额度", "开票", "完成", "错误", "失败"):
        for line in reversed(lines):
            if key in line and line not in picked:
                picked.append(line)
                break
    essentials = [re.sub(r"^\[[^\]]+\]\s*", "", l) for l in picked[:3]]
    summary = "；".join(essentials) if essentials else (lines[-1] if lines else "无日志输出")
    if not force and already_delivered('deepseek-invoice'):
        print(json.dumps({"ok": True, "skipped": "already delivered today"}, ensure_ascii=False))
        return 0
    cmd = [DELIVER, "--task", "deepseek-invoice", "--result", result,
           "--summary", "deepseek-invoice：" + summary[:200], "--detail-url", path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout.strip())
    if res.returncode != 0:
        print(res.stderr.strip(), file=sys.stderr)
    else:
        mark_delivered('deepseek-invoice')
    return res.returncode

if __name__ == "__main__":
    sys.exit(main())
