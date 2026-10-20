#!/usr/bin/env python3
"""Record and compare GitHub traffic — the only instrument that can tell whether
the discoverability work actually changed anything.

Why a separate script with its own storage
------------------------------------------
GitHub's traffic API (`/traffic/views`, `/traffic/clones`) retains **14 days**.
Older data is deleted server-side and cannot be requested again. So a baseline
that is not copied out today is gone forever — which means the comparison has to
be split into two runs with our own snapshot in between:

    today        --record   →  writes traffic-baseline.json
    +14 days     --compare  →  reads it, prints the delta

What this can and cannot prove
------------------------------
`views` is the honest signal: it counts page opens by a human or an agent that
followed a link. `clones` is polluted — every CI checkout, every scheduled
workflow and every local `git fetch` lands there. On LyraWang6688/ai-capability-store
the 14-day numbers were 27 views / 1 unique visitor against 1,730 clones /
331 unique cloners, and most of those clones are the automation itself.

So: read the views delta as the measurement, and the clones delta as noise that
occasionally hints at agent traffic.

Usage:
    python3 traffic_baseline.py --owner LyraWang6688 --record
    python3 traffic_baseline.py --owner LyraWang6688 --compare
    python3 traffic_baseline.py --record --repos LyraWang6688/a LyraWang6688/b
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

STORE = os.path.expanduser("~/.automation-state/repo-discoverability/traffic.json")
WINDOW_DAYS = 14  # GitHub's own retention; longer gaps cannot be compared


def gh_json(path: str):
    completed = subprocess.run(["gh", "api", path], capture_output=True,
                               text=True, timeout=90)
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None


def collect(repo: str) -> dict | None:
    views = gh_json(f"repos/{repo}/traffic/views")
    clones = gh_json(f"repos/{repo}/traffic/clones")
    if views is None and clones is None:
        return None
    return {
        "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "views": {"count": (views or {}).get("count", 0),
                  "uniques": (views or {}).get("uniques", 0)},
        "clones": {"count": (clones or {}).get("count", 0),
                   "uniques": (clones or {}).get("uniques", 0)},
    }


def load_store() -> dict:
    if not os.path.isfile(STORE):
        return {"owner": None, "snapshots": []}
    try:
        with open(STORE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {"owner": None, "snapshots": []}


def save_store(data: dict) -> None:
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    tmp = STORE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, STORE)


def public_repos(owner: str) -> list[str]:
    listing = gh_json(f"users/{owner}/repos?per_page=100&type=public") or []
    return [r["full_name"] for r in listing if not r.get("archived")]


def days_between(a: str, b: str) -> int:
    def parse(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parse(b) - parse(a)).days


def cmd_record(args) -> int:
    repos = args.repos or public_repos(args.owner)
    store = load_store()
    store["owner"] = args.owner
    snapshot = {"recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "repos": {}}
    for repo in repos:
        data = collect(repo)
        if data is None:
            print(f"  [跳过] {repo}（读不到 traffic，可能无权限或仓库为空）")
            continue
        snapshot["repos"][repo] = data
        v, c = data["views"], data["clones"]
        print(f"  ✅ {repo:46s} 观看 {v['count']:>4}/{v['uniques']:>3}人   clone {c['count']:>5}/{c['uniques']:>4}来源")
    store["snapshots"].append(snapshot)
    save_store(store)
    print(f"\n  基线已记录 → {STORE}")
    print(f"  共 {len(store['snapshots'])} 次快照；下次用 --compare 对比")
    return 0


def cmd_compare(args) -> int:
    store = load_store()
    snapshots = store.get("snapshots") or []
    if len(snapshots) < 2:
        print(f"  只有 {len(snapshots)} 次快照，至少需要 2 次才能对比。")
        print("  先跑 --record 记基线；14 天后再跑 --record + --compare。")
        return 1

    first, last = snapshots[0], snapshots[-1]
    gap = days_between(first["recorded_at"], last["recorded_at"])
    print(f"\n  对比：{first['recorded_at'][:10]} → {last['recorded_at'][:10]}  （间隔 {gap} 天）")
    if gap < WINDOW_DAYS:
        print(f"  ⚠️ 间隔不足 {WINDOW_DAYS} 天，两个窗口有重叠，增量会偏小。")
    if gap > WINDOW_DAYS * 2:
        print(f"  ⚠️ 间隔超过 {WINDOW_DAYS * 2} 天，GitHub 的 14 天窗口已经错开，数字不可直接相减。")

    print(f"\n  {'仓库':44s} {'观看增量':>10s} {'访客增量':>10s} {'clone 增量':>12s}")
    print("  " + "-" * 82)
    for repo in sorted(set(first["repos"]) | set(last["repos"])):
        a = first["repos"].get(repo, {})
        b = last["repos"].get(repo, {})
        dv = (b.get("views", {}).get("count", 0) - a.get("views", {}).get("count", 0))
        du = (b.get("views", {}).get("uniques", 0) - a.get("views", {}).get("uniques", 0))
        dc = (b.get("clones", {}).get("count", 0) - a.get("clones", {}).get("count", 0))
        print(f"  {repo:44s} {dv:>10d} {du:>10d} {dc:>12d}")

    print("\n  判读提醒：")
    print("   · 看【观看】增量，那是人/agent 真的打开了页面")
    print("   · clone 增量混着 CI checkout 和你自己的 fetch，只能当参考")
    print("   · 单个仓库的波动可能来自一次分享，要看多个仓库的整体方向")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--repos", nargs="*", help="限定仓库，默认该 owner 下全部非归档公开仓库")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--record", action="store_true", help="记录一次快照")
    action.add_argument("--compare", action="store_true", help="和第一次快照对比")
    args = parser.parse_args()
    return cmd_record(args) if args.record else cmd_compare(args)


if __name__ == "__main__":
    sys.exit(main())
