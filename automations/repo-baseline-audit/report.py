#!/usr/bin/env python3
"""给 DSH 会话用的周报数据：读飞书「仓库基线体检」表里最近一次的结果。

用法：python3 report.py [--days 7]
输出：{"generated_at","since","count","repos":[{仓库,PASS,FAIL,UNKNOWN,不合格项}]}
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import date, timedelta

BASE_TOKEN = os.environ.get("BASELINE_BASE_TOKEN") or "ZNjDb9TrpalLuCsw0macCeVdnld"
TABLE_ID = os.environ.get("BASELINE_TABLE_ID") or "tbloNfrzuBscST9I"


def lark(args):
    cmd = ["lark-cli"] + args + ["--as", "user", "--format", "json"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SystemExit("读取投递箱失败：" + (r.stderr or r.stdout)[:300])
    return json.loads(r.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    data = lark(["base", "+record-list", "--base-token", BASE_TOKEN, "--table-id", TABLE_ID, "--limit", "200"])["data"]
    cols = data.get("fields") or []
    idx = {c: i for i, c in enumerate(cols)}
    rows = data.get("data") or []
    cell_of = lambda r, name: r[idx[name]] if name in idx else None
    days = [str(cell_of(r, "检查日期") or "") for r in rows]
    latest = max([d for d in days if d] or [""])
    since = latest or (date.today() - timedelta(days=args.days)).isoformat()
    items = []
    for r in rows:
        cell = lambda name, row=r: cell_of(row, name)
        day = str(cell("检查日期") or "")
        if latest:
            if day != latest:
                continue
        elif day and day < since:
            continue
        items.append({
            "仓库": str(cell("仓库") or ""),
            "PASS": cell("PASS") or 0,
            "FAIL": cell("FAIL") or 0,
            "UNKNOWN": cell("UNKNOWN") or 0,
            "不合格项": str(cell("不合格项") or ""),
        })
    items.sort(key=lambda x: x["FAIL"], reverse=True)
    print(json.dumps({
        "generated_at": date.today().isoformat(),
        "since": since,
        "count": len(items),
        "repos": items,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
