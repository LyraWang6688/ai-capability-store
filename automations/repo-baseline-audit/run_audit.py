#!/usr/bin/env python3
"""公开仓库基线体检（月度自动化）：批量审计 + 写入飞书 Base。

用法：
    python3 run_audit.py [--owner LyraWang6688] [--dry-run] [--limit N]
"""
import argparse
import json
import os
import re
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


def list_public_repos(owner, include_archived=False, include_forks=False, public_only=False):
    """名下仓库（公开+私有）；默认跳过已归档和 fork。

    用 `gh repo list`（登录态）而不是 `users/<owner>/repos`（后者只返回公开仓库）。
    """
    result = subprocess.run(
        ["gh", "repo", "list", owner, "--limit", "200",
         "--json", "nameWithOwner,isPrivate,isArchived,isFork"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise SystemExit("列举仓库失败：" + (result.stderr or result.stdout)[:300])
    try:
        repos = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        raise SystemExit("解析仓库列表失败")
    names = []
    for repo in repos:
        if repo.get("isArchived") and not include_archived:
            continue
        if repo.get("isFork") and not include_forks:
            continue
        if public_only and repo.get("isPrivate"):
            continue
        names.append(repo.get("nameWithOwner"))
    return sorted({name for name in names if name})


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
        "visibility": "私有" if (isinstance(extra, dict) and extra.get("private")) else "公开",
        "pass": counts[ab.PASS],
        "fail": counts[ab.FAIL],
        "unknown": counts[ab.UNKNOWN],
        "failing": failing_text(res),
        "fail_ids": [iid for iid, _g, _n, _f in ab.ITEMS if res.get(iid) == ab.FAIL],
        "unknown_ids": [iid for iid, _g, _n, _f in ab.ITEMS if res.get(iid) == ab.UNKNOWN],
        "counts": counts,
        "branch": extra.get("branch") if isinstance(extra, dict) else "",
    }


def write_rows(cfg, rows, dry_run):
    if dry_run:
        print(json.dumps({"dry_run": True, "rows": rows}, ensure_ascii=False, indent=2))
        return 0
    today = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    records = [{
        "仓库": row["repo"],
        "可见性": [row.get("visibility") or "公开"],
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



TITLE_PREFIX = "[baseline]"


def gh(args, timeout=90):
    return subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=timeout)


def open_baseline_issue(repo):
    """Find an existing open [baseline] issue in <repo>."""
    r = gh(["issue", "list", "-R", repo, "--state", "open", "--limit", "200",
            "--search", "baseline in:title", "--json", "number,title,body"])
    if r.returncode != 0:
        return None
    try:
        items = json.loads(r.stdout or "[]")
    except json.JSONDecodeError:
        return None
    for item in items:
        if str(item.get("title", "")).startswith(TITLE_PREFIX):
            return item
    return None


def issue_body(row):
    counts = row["counts"]
    groups = {}
    for iid in row["fail_ids"]:
        for item_id, grp, label, fix in ab.ITEMS:
            if item_id == iid:
                groups.setdefault(grp, []).append((item_id, label, fix))
    lines = [
        "## 自动审计结果",
        "",
        f"`PASS {counts[ab.PASS]} · FAIL {counts[ab.FAIL]} · UNKNOWN {counts[ab.UNKNOWN]}`",
        "",
        "由 `repo-baseline-audit` 自动生成（GitHub Actions，每周一次）。修复后无需手动关闭，下一轮审计通过即可。",
        "",
    ]
    for grp, items in groups.items():
        lines.append(f"### {grp}")
        for iid, label, fix in items:
            lines.append(f"- [ ] **{iid} {label}** — {fix}")
        lines.append("")
    if row["unknown_ids"]:
        lines += ["### 查不到（UNKNOWN，不代表没开）", "", "需要人工确认：", ""]
        for iid in row["unknown_ids"]:
            for item_id, _grp, label, _fix in ab.ITEMS:
                if item_id == iid:
                    lines.append(f"- {iid} {label}")
        lines.append("")
    lines += [
        "---",
        "> ⚠️ 不要给没有 CI 的仓库开启 required status checks，否则合并会被锁死。",
        "> 本 issue 只做记录，不会自动修改仓库设置。",
    ]
    return "\n".join(lines)


def extract_fail_ids(body):
    return set(re.findall(r"- \[[ x]\] \*\*([A-E]\d)", body or ""))


def sync_issues(rows, dry_run):
    """Create one [baseline] issue per repo, then comment weekly deltas."""
    created, commented, none = [], [], []
    for row in rows:
        repo = row["repo"]
        existing = open_baseline_issue(repo)
        if row["fail_ids"] == []:
            if existing:
                if not dry_run:
                    gh(["issue", "comment", "-R", repo, "--body",
                        f"## 周度同步\n\n`PASS {row['counts'][ab.PASS]} · FAIL 0 · UNKNOWN {row['counts'][ab.UNKNOWN]}`\n\n本轮审计全部通过，issue 可以关闭 ✅"])
                commented.append(repo)
            continue
        if existing is None:
            if not dry_run:
                r = gh(["issue", "create", "-R", repo,
                        "--title", f"{TITLE_PREFIX} 项目基线审计：{row['counts'][ab.FAIL]} 项待修复",
                        "--body", issue_body(row)])
                if r.returncode == 0:
                    created.append((repo, r.stdout.strip().splitlines()[-1]))
            else:
                created.append((repo, "dry-run"))
            continue
        previous = extract_fail_ids(existing.get("body"))
        current = set(row["fail_ids"])
        added = sorted(current - previous)
        fixed = sorted(previous - current)
        lines = [
            "## 周度同步",
            "",
            f"`PASS {row['counts'][ab.PASS]} · FAIL {row['counts'][ab.FAIL]} · UNKNOWN {row['counts'][ab.UNKNOWN]}`",
            "",
            f"新增未通过项：{', '.join(added) if added else '无'}",
            f"已修复项：{', '.join(fixed) if fixed else '无'}",
        ]
        if not dry_run:
            gh(["issue", "comment", "-R", repo, "--body", "\n".join(lines)])
        commented.append(repo)
    print(json.dumps({"issues_created": len(created), "issues_commented": len(commented) + len(none),
                      "dry_run": dry_run, "created": created}, ensure_ascii=False), file=sys.stderr)
    return created, commented


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--include-archived", action="store_true", help="把已归档仓库也纳入审计")
    parser.add_argument("--include-forks", action="store_true", help="把 fork 仓库也纳入审计")
    parser.add_argument("--public-only", action="store_true", help="只审计公开仓库")
    parser.add_argument("--sync-issues", action="store_true", help="每仓库维护一个 [baseline] issue（创建或评论）")
    parser.add_argument("--dry-run", default=os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes"))
    args = parser.parse_args()

    repos = list_public_repos(args.owner, args.include_archived, args.include_forks, args.public_only)
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
    if args.sync_issues:
        sync_issues(rows, args.dry_run)
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
