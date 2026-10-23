#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读 ops-audit 最新 JSON 报告，生成一句话摘要并投递到任务收件箱。

用 systemd 的 ExecMainStatus 判断成功/失败（ops-audit 退出码 3 = 发现问题）。
报告日期不是今天则跳过（说明今天没跑，避免重复投递旧报告）。
"""
import datetime, glob, json, os, subprocess, sys

REPORT_DIR = os.environ.get("OPS_AUDIT_REPORT_DIR", "/var/lib/ops-audit/reports")
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

UNIT = os.environ.get("OPS_AUDIT_UNIT", "ops-audit.service")

def latest_json():
    files = sorted(glob.glob(os.path.join(REPORT_DIR, "*.json")))
    return files[-1] if files else None

def service_status():
    res = subprocess.run(["systemctl", "show", UNIT, "-p", "ExecMainStatus", "-p", "Result"],
                         capture_output=True, text=True)
    out = dict(line.split("=", 1) for line in res.stdout.strip().splitlines() if "=" in line)
    return out.get("ExecMainStatus", ""), out.get("Result", "")

def main():
    force = "--force" in sys.argv
    path = latest_json()
    if path is None:
        print(json.dumps({"ok": False, "message": "no ops-audit report found"}, ensure_ascii=False))
        return 0
    with open(path, encoding="utf-8") as fh:
        report = json.load(fh)
    date = str(report.get("date") or "")
    if not force and date != datetime.date.today().isoformat():
        print(json.dumps({"ok": True, "skipped": "report is not today's", "report": path}, ensure_ascii=False))
        return 0

    issues = report.get("issues") or []
    projects = report.get("projects") or []
    code, result_state = service_status()
    if result_state == "timeout":
        result = "超时"
    elif code in ("0", "3"):
        result = "成功"
    elif code in ("", "0"):
        result = "成功"
    else:
        result = "失败"
    if issues:
        first = issues[0]
        if isinstance(first, list):
            first = "、".join(str(x) for x in first)
        summary = "%s ops-audit：%d 项问题、%d 个项目；%s" % (date, len(issues), len(projects), str(first)[:80])
    else:
        summary = "%s ops-audit：无问题；%d 个项目全部检查完成" % (date, len(projects))
    if not force and already_delivered('ops-audit'):
        print(json.dumps({"ok": True, "skipped": "already delivered today"}, ensure_ascii=False))
        return 0
    cmd = [DELIVER, "--task", "ops-audit", "--result", result, "--summary", summary, "--detail-url", path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout.strip())
    if res.returncode != 0:
        print(res.stderr.strip(), file=sys.stderr)
    else:
        mark_delivered('ops-audit')
    return res.returncode

if __name__ == "__main__":
    sys.exit(main())
