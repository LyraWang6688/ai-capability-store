#!/usr/bin/env python3
"""frontier-watch report — 读飞书 Base 里 frontier-watch 写入的条目，输出到 DSH 会话。

由本机 DSH 定时任务调用（需要 lark-cli 已授权）。CI 只负责采集与写入。
"""
import json
import os
import subprocess
import sys
from datetime import date, timedelta

CONFIG_PATH = os.path.expanduser("~/.automation-state/frontier-watch/config.json")
DEFAULTS = {"base_token": "", "table_id": "", "lark_cli": "lark-cli", "lark_profile": ""}


def load_config():
    raw = os.environ.get("FRONTIER_CONFIG_JSON")
    cfg = dict(DEFAULTS)
    if raw:
        cfg.update(json.loads(raw))
    elif os.path.exists(CONFIG_PATH):
        cfg.update(json.loads(open(CONFIG_PATH, encoding="utf-8").read()))
    return cfg


def lark(cfg, args):
    argv = [cfg["lark_cli"]]
    if cfg.get("lark_profile"):
        argv += ["--profile", cfg["lark_profile"]]
    argv += args + ["--as", "user", "--format", "json"]
    result = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise SystemExit("读取 Base 失败：" + (result.stderr or result.stdout)[:300])
    return json.loads(result.stdout)


def fetch_rows(cfg):
    rows = []
    offset = 0
    while True:
        data = lark(cfg, ["base", "+record-list", "--base-token", cfg["base_token"], "--table-id", cfg["table_id"], "--limit", "200", "--offset", str(offset)])["data"]
        columns = data.get("fields") or []
        index = {name: i for i, name in enumerate(columns)}
        for row in data.get("data") or []:
            rows.append({name: row[i] if i < len(row) else None for name, i in index.items()})
        if not data.get("has_more"):
            break
        offset += len(data.get("data") or [])
    return rows


def pick(value):
    if isinstance(value, list) and value:
        value = value[0]
    if isinstance(value, dict):
        value = value.get("text") or value.get("name")
    return value if value is not None else ""


def main():
    since = (date.today() - timedelta(days=7)).isoformat()
    args = sys.argv[1:]
    if "--since" in args:
        since = args[args.index("--since") + 1]
    cfg = load_config()
    if not cfg.get("base_token") or not cfg.get("table_id"):
        raise SystemExit("缺少 base_token / table_id（FRONTIER_CONFIG_JSON 或本地配置）")
    rows = [row for row in fetch_rows(cfg)
            if pick(row.get("来源")) == "frontier-watch" and pick(row.get("收录日")) >= since]
    items = [{
        "feature": pick(row.get("功能/灵感")),
        "tool": pick(row.get("工具")),
        "priority": pick(row.get("优先级")),
        "feasible": pick(row.get("可否做成DSH插件")),
        "desc": pick(row.get("说明")),
    } for row in rows]
    print(json.dumps({"since": since, "count": len(items), "items": items}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
