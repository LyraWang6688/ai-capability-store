#!/usr/bin/env python3
"""公开仓库基线体检（月度自动化）：批量审计 + 写入飞书 Base。

用法：
    python3 run_audit.py [--owner LyraWang6688] [--dry-run] [--limit N]
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_baseline as ab  # noqa: E402

FEISHU_BASE = "https://open.feishu.cn/open-apis"
CONFIG_ENV = "BASELINE_CONFIG_JSON"
TOKEN_CACHE = {}


def feishu(method, path, body=None, token=None):
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(FEISHU_BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if int(payload.get("code") or 0) != 0:
        raise SystemExit(f"飞书 API 失败 [{payload.get('code')}] {payload.get('msg')}")
    return payload.get("data") or {}


def tenant_token():
    if TOKEN_CACHE.get("token"):
        return TOKEN_CACHE["token"]
    app_id = (os.environ.get("FEISHU_APP_ID") or "").strip()
    app_secret = (os.environ.get("FEISHU_APP_SECRET") or "").strip()
    if not app_id or not app_secret:
        raise SystemExit("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET")
    payload = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode()
    req = urllib.request.Request(
        FEISHU_BASE + "/auth/v3/tenant_access_token/internal",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if int(data.get("code") or 0) != 0 or not data.get("tenant_access_token"):
        raise SystemExit(f"获取 tenant token 失败 [{data.get('code')}] {data.get('msg')}")
    TOKEN_CACHE["token"] = data["tenant_access_token"]
    return TOKEN_CACHE["token"]


def load_config():
    raw = os.environ.get(CONFIG_ENV)
    if not raw:
        raise SystemExit(f"缺少环境变量 {CONFIG_ENV}（形如 {json.dumps({'base_token': '...', 'table_id': '...'})}）")
    cfg = json.loads(raw)
    if not cfg.get("base_token") or not cfg.get("table_id"):
        raise SystemExit(f"{CONFIG_ENV} 需要 base_token 与 table_id")
    return cfg


def list_public_repos(owner):
    result = subprocess.run(
        ["gh", "api", f"users/{owner}/repos?per_page=100&type=owner", "--paginate",
         "--jq", ".[] | select(.private == false) | .full_name"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise SystemExit("列举仓库失败：" + (result.stderr or result.stdout)[:300])
    names = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return sorted(set(names))


def failing_text(res):
    names = []
    for iid, _grp, name, _fix in ab.ITEMS:
        if res.get(iid) == ab.FAIL:
            names.append(f"{iid} {name}")
    return "；".join(names)


def audit_repo(repo):
    res, extra = ab.audit(repo)
    if res is None:
        return None
    counts = {ab.PASS: 0, ab.FAIL: 0, ab.UNKNOWN: 0}
    for iid, _grp, _name, _fix in ab.ITEMS:
        state = res.get(iid, ab.UNKNOWN)
        counts[state] = counts.get(state, 0) + 1
    return {
        "repo": repo,
        "pass": counts[ab.PASS],
        "fail": counts[ab.FAIL],
        "unknown": counts[ab.UNKNOWN],
        "failing": failing_text(res),
        "branch": extra.get("branch") if isinstance(extra, dict) else "",
    }


def write_rows(cfg, rows, dry_run):
    if dry_run:
        print(json.dumps({"dry_run": True, "rows": rows}, ensure_ascii=False, indent=2))
        return 0
    today = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    records = [{
        "仓库": row["repo"],
        "检查日期": today,
        "PASS": row["pass"],
        "FAIL": row["fail"],
        "UNKNOWN": row["unknown"],
        "不合格项": row["failing"][:800],
    } for row in rows]
    written = 0
    token = tenant_token()
    for start in range(0, len(records), 200):
        chunk = records[start:start + 200]
        path = f"/base/v3/bases/{cfg['base_token']}/tables/{cfg['table_id']}/records/batch_create"
        feishu("POST", path, {"create_records": chunk}, token)
        written += len(chunk)
    return written


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", default=os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes"))
    args = parser.parse_args()

    repos = list_public_repos(args.owner)
    if args.limit:
        repos = repos[:args.limit]
    print(f"公开仓库：{len(repos)} 个", file=sys.stderr)

    rows = []
    for repo in repos:
        if repo.split("/")[1].startswith("."):
            continue
        print(f"- 审计 {repo} ...", file=sys.stderr, flush=True)
        row = audit_repo(repo)
        if row is None:
            print(f"  skip {repo}", file=sys.stderr)
            continue
        rows.append(row)
        print(f"  PASS {row['pass']} / FAIL {row['fail']} / UNKNOWN {row['unknown']}", file=sys.stderr)

    rows.sort(key=lambda r: r["fail"], reverse=True)
    written = 0
    if not args.dry_run:
        written = write_rows(load_config(), rows, False)
    print(json.dumps({
        "owner": args.owner,
        "repos": len(rows),
        "total_fail": sum(r["fail"] for r in rows),
        "written": written,
        "dry_run": args.dry_run,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
