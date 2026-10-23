#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一条任务结果写进飞书「任务收件箱」（Mac 侧，使用本机 lark-cli 用户身份）。

用法:
  inbox-deliver-mac.py --task chrome-frequent-pages --result 成功 --summary "本周新增 3 条"
"""
import argparse, json, subprocess, sys
from datetime import datetime

BASE = "NeujbbOfcaPEvMsPIxscaJImn9d"
INBOX = "tbl9LghPBTjFLH4N"
TASKS = "tbl4k7ggY1paqoUn"
LARK = "lark-cli"

def lark(args):
    cmd = [LARK] + args + ["--as", "user", "--format", "json"]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    try:
        payload = json.loads(res.stdout or "{}")
    except Exception:
        payload = {}
    if payload.get("ok") is False:
        raise SystemExit("lark-cli failed: " + json.dumps(payload.get("error", payload), ensure_ascii=False))
    if res.returncode != 0:
        raise SystemExit("lark-cli exited %s: %s" % (res.returncode, (res.stderr or "")[:300]))
    return payload

def task_record_id(name):
    payload = lark(["base", "+record-list", "--base-token", BASE, "--table-id", TASKS, "--limit", "200"])
    meta = payload.get("data") or {}
    fields = meta.get("fields") or []
    rows = meta.get("data") or []
    ids = meta.get("record_id_list") or []
    if "任务名称" not in fields:
        return ""
    idx = fields.index("任务名称")
    for rid, row in zip(ids, rows):
        if str(row[idx]).strip() == name:
            return str(rid)
    return ""

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--result", required=True, choices=["成功", "失败", "超时"])
    ap.add_argument("--summary", required=True)
    args = ap.parse_args()
    summary = args.summary.strip()
    if len(summary) > 300:
        summary = summary[:299] + "…"
    record = {
        "结果摘要": summary,
        "结果": [args.result],
        "状态": ["未读"],
        "执行任务": int(datetime.now().timestamp() * 1000),
    }
    rid = task_record_id(args.task)
    if rid:
        record["关联任务"] = [rid]
    lark(["base", "+record-batch-create", "--base-token", BASE, "--table-id", INBOX,
          "--json", json.dumps({"create_records": [record]}, ensure_ascii=False)])
    print(json.dumps({"ok": True, "task": args.task, "linked": bool(rid)}, ensure_ascii=False))

if __name__ == "__main__":
    main()
