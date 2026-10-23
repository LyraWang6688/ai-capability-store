#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""导出「常用网页」表的 域名 -> {标题, 分类} 快照，供 run-if-due.sh 做前后 diff。"""
import json, subprocess, sys

BASE = "ZNjDb9TrpalLuCsw0macCeVdnld"
TABLE = "tblDejemWsgqKSA2"

def main():
    out = subprocess.run(
        ["lark-cli", "base", "+record-list", "--base-token", BASE, "--table-id", TABLE,
         "--limit", "200", "--as", "user", "--format", "json"],
        capture_output=True, text=True, timeout=120)
    try:
        data = json.loads(out.stdout)
    except Exception:
        print("{}")
        return 1
    meta = (data.get("data") or {})
    cols = meta.get("fields") or []
    rows = meta.get("data") or []
    if "域名" not in cols:
        print("{}")
        return 1
    idx = {name: i for i, name in enumerate(cols)}
    snap = {}
    for row in rows:
        host = str(row[idx["域名"]] or "").strip()
        if not host:
            continue
        cat = "其他"
        if "分类" in idx:
            raw = row[idx["分类"]]
            if isinstance(raw, list) and raw:
                cat = str(raw[0])
            elif isinstance(raw, str) and raw.strip():
                cat = raw.strip()
        title = ""
        if "标题" in idx and row[idx["标题"]]:
            title = str(row[idx["标题"]]).strip()
        snap[host] = {"title": title or host, "cat": cat}
    print(json.dumps(snap, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
