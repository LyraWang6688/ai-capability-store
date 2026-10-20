#!/usr/bin/env python3
"""Read the open `discoverability` issues and hand them to the DSH session as JSON.

This is the local half of the automation, the same shape as
`repo-baseline-audit/report.py` and `frontier-watch/report.py`:

    GitHub Actions (cloud)  →  opens issues on each non-compliant repo
    this script (local)     →  reads those issues, emits JSON
    DSH session (dialogue)  →  turns the JSON into a Chinese weekly summary

Why not just read GitHub directly in the conversation? Because the point of the
split is that the cloud part never misses a week (it does not need the machine to
be on), while the summary part is only useful when someone is actually reading.

Read-only: this never writes to any repository.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

MARKER = "<!-- repo-discoverability-bot -->"
LABEL = "discoverability"
CST = timezone(timedelta(hours=8))


def gh_json(args):
    completed = subprocess.run(["gh", *args], capture_output=True,
                               text=True, timeout=120)
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None


def public_repos(owner: str) -> list[str]:
    listing = gh_json(["api", f"users/{owner}/repos?per_page=100&type=public"]) or []
    return [r["full_name"] for r in listing if not r.get("archived")]


def open_issue(repo: str) -> dict | None:
    items = gh_json(["api", f"repos/{repo}/issues?state=open&labels={LABEL}&per_page=10"])
    if not isinstance(items, list):
        return None
    for issue in items:
        if issue.get("pull_request"):
            continue
        if MARKER in (issue.get("body") or ""):
            return issue
    return None


def parse_failures(body: str) -> list[dict]:
    """Pull the `| Dx title | tier | detail | fix |` rows out of the issue body."""
    rows = []
    for line in (body or "").split("\n"):
        stripped = line.strip()
        if not stripped.startswith("| `D"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 4:
            continue
        code_title = cells[0]
        code, _, title = code_title.partition(" ")
        code = code.strip("`").strip()
        title = title.strip().strip("`").strip()
        rows.append({"code": code or code_title, "title": title or code_title,
                     "tier": cells[1], "detail": cells[2], "fix": cells[3]})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--days", type=int, default=7,
                        help="只看这段时间内创建/更新的 issue")
    parser.add_argument("--json", action="store_true", default=True)
    args = parser.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    repos = public_repos(args.owner)

    behind, clean, errors = [], [], []
    for repo in repos:
        issue = open_issue(repo)
        if issue is None:
            clean.append(repo)
            continue
        try:
            updated = datetime.fromisoformat(
                issue["updated_at"].replace("Z", "+00:00"))
        except Exception:
            updated = datetime.now(timezone.utc)
        entry = {
            "repo": repo,
            "issue": issue["number"],
            "url": issue["html_url"],
            "title": issue["title"],
            "updated_at": issue["updated_at"],
            "updated_this_window": updated >= cutoff,
            "failures": parse_failures(issue.get("body") or ""),
        }
        behind.append(entry)

    payload = {
        "as_of": datetime.now(CST).isoformat(timespec="seconds"),
        "owner": args.owner,
        "window_days": args.days,
        "counts": {"behind": len(behind), "clean": len(clean),
                   "updated_this_window": sum(1 for e in behind if e["updated_this_window"]),
                   "failures_total": sum(len(e["failures"]) for e in behind)},
        "behind": sorted(behind, key=lambda e: -len(e["failures"])),
        "clean": clean,
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
