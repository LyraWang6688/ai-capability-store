#!/usr/bin/env python3
"""Consumer side of this automation's `output.target: git-branch` contract.

Pulls `trending/<date>.json` from the Store's `data` branch into a local
directory, so an unattended agent can read output produced by the scheduled
github-actions run — including on days the local machine was off.

Lives next to the producer on purpose: the producer owns the output format, so it
should own the reader that has to agree with it. The weekly automation reads the
same branch and uses this same script.

The cloud automation (ai-capability-store/automations/github-trending-daily) runs
on GitHub's schedule and commits `trending/<date>.json` to the **data** branch.
This tool brings those files down so the DSH consumer can read them even on days
the local machine was off.

Design constraints:
  * NEVER fatal. The DSH consumer falls back to a local scan; a sync failure must
    degrade to "no cloud data", not to "task failed".
  * Only fetches MISSING days — it never overwrites a snapshot that already exists,
    so a locally-produced snapshot is never silently replaced by a cloud one.
  * Uses `gh api` (works for private repos, reuses the CLI's existing auth) rather
    than raw HTTP, so no token handling here.

Exit codes:
  0  sync completed (including "nothing to do" and "gh unavailable")
  1  unexpected error  (still non-fatal to the caller, which checks output only)
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import subprocess
import sys

DEFAULT_REPO = "LyraWang6688/ai-capability-store"
DEFAULT_BRANCH = "data"
DEFAULT_DEST = os.path.expanduser("~/.automation-state/github-trending/trending")
CONTENT_PREFIX = "trending"


def _load_snapshot(repo: str, branch: str, day: str) -> dict | None:
    """Fetch one snapshot from the data branch. None means 'absent or unreadable'."""
    path = f"{CONTENT_PREFIX}/{day}.json"
    try:
        completed = subprocess.run(
            ["gh", "api", f"repos/{repo}/contents/{path}?ref={branch}", "--jq", ".content"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        raw = base64.b64decode(completed.stdout.strip().replace("\n", ""))
        document = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    # Guard: only accept a document that declares the automation that produced it.
    if not isinstance(document, dict) or "candidates" not in document:
        return None
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--dest", default=DEFAULT_DEST, help="local snapshot directory")
    parser.add_argument("--days", type=int, default=7, help="how many past days to consider")
    parser.add_argument("--json", action="store_true", help="machine-readable summary")
    args = parser.parse_args()

    today = dt.date.today()
    wanted = [(today - dt.timedelta(days=offset)).isoformat() for offset in range(args.days)]
    os.makedirs(args.dest, exist_ok=True)

    fetched: list[str] = []
    present: list[str] = []
    absent: list[str] = []

    for day in wanted:
        target = os.path.join(args.dest, f"{day}.json")
        if os.path.exists(target):
            present.append(day)
            continue
        document = _load_snapshot(args.repo, args.branch, day)
        if document is None:
            absent.append(day)
            continue
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2)
        fetched.append(day)

    summary = {
        "repo": args.repo,
        "branch": args.branch,
        "dest": args.dest,
        "window_days": args.days,
        "fetched": fetched,
        "already_present": present,
        "absent_in_cloud": absent,
        "today_available": today.isoformat() in fetched or today.isoformat() in present,
    }
    if args.json:
        json.dump(summary, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"repo            : {args.repo} (branch {args.branch})")
        print(f"dest            : {args.dest}")
        print(f"fetched         : {fetched or '—'}")
        print(f"already present : {len(present)} day(s)")
        print(f"absent in cloud : {absent or '—'}")
        print(f"today available : {summary['today_available']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — a sync failure must never break the task
        sys.stderr.write(f"[warn] sync_from_cloud failed (non-fatal): {exc}\n")
        sys.exit(1)
