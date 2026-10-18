#!/usr/bin/env python3
"""GitHub Trending weekly aggregate — turn 7 daily snapshots into trend signal.

Reads the daily snapshots written by `github-trending-daily` and separates
what PERSISTED from what merely spiked:

  * topic.days_present   how many of the window's days the topic appeared
  * repo.days_seen       how many days the repository was surfaced
  * repo.star_delta      net star growth across the window (reliable)
  * repo.peak_daily_gain single-day best (noisy — kept for contrast only)

An explicit `note` states whether the window holds enough data to judge; with
fewer than 3 days the output says so instead of manufacturing a trend claim.

Output: one JSON document on stdout.
Exit:   0 on success; 2 when no snapshot could be read at all.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
from collections import defaultdict

SNAPSHOT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")
MIN_TRUSTED_DAYS = 3
SUSTAINED_RATIO = 0.6
MIN_PEAK_FOR_ONE_DAY = 500


def load_snapshots(data_dir: str, days: int) -> tuple[dict[str, dict], list[str]]:
    """Load the snapshots inside the window. Missing days are INFORMED, not hidden."""
    today = dt.date.today()
    window = [today - dt.timedelta(days=offset) for offset in range(days - 1, -1, -1)]
    loaded: dict[str, dict] = {}
    for day in window:
        path = os.path.join(data_dir, f"{day.isoformat()}.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                loaded[day.isoformat()] = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
    return loaded, [day.isoformat() for day in window if day.isoformat() not in loaded]


def aggregate(snapshots: dict[str, dict], days: int) -> dict:
    """Pure function of the snapshots: `missing` is DERIVED from the window, never
    taken from the caller. An earlier version accepted it as an argument, which
    let a caller pass [] and get `note: "window complete"` while holding 3 of 7
    days — the exact failure this function exists to prevent."""
    today = dt.date.today()
    window = [(today - dt.timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]
    missing = [day for day in window if day not in snapshots]
    day_count = len(snapshots)
    topic_days: dict[str, set[str]] = defaultdict(set)
    topic_repos: dict[str, int] = defaultdict(int)
    for day, snapshot in snapshots.items():
        for row in snapshot.get("topic_frequency", []):
            topic_days[row["topic"]].add(day)
            topic_repos[row["topic"]] += row["repos"]

    topics = [
        {
            "topic": topic,
            "days_present": len(topic_days[topic]),
            "persistence": round(len(topic_days[topic]) / day_count, 2),
            "total_repo_sightings": topic_repos[topic],
            "verdict": (
                "persistent"
                if len(topic_days[topic]) >= max(MIN_TRUSTED_DAYS, day_count * SUSTAINED_RATIO)
                else "emerging"
                if dt.date.today().isoformat() in topic_days[topic]
                and len(topic_days[topic]) <= 2
                else "intermittent"
            ),
        }
        for topic in topic_days
    ]
    topics.sort(key=lambda t: (t["days_present"], t["total_repo_sightings"]), reverse=True)

    seen: dict[str, dict] = defaultdict(
        lambda: {"days": [], "stars": {}, "gain": 0, "topics": [], "desc": ""}
    )
    for day, snapshot in snapshots.items():
        for candidate in snapshot.get("candidates", []):
            entry = seen[candidate["repo"]]
            entry["days"].append(day)
            entry["stars"][day] = candidate.get("stars", 0)
            # trend_gain is None when the source carries no daily velocity
            # (weekly page, topic search). Unknown must not be read as a peak.
            gain = candidate.get("trend_gain")
            if gain is not None:
                entry["gain"] = max(entry["gain"], gain)
            if candidate.get("topics") and not entry["topics"]:
                entry["topics"] = candidate["topics"]
            if candidate.get("desc") and not entry["desc"]:
                entry["desc"] = candidate["desc"][:160]

    repos = []
    for repo, entry in seen.items():
        ordered = sorted(set(entry["days"]))
        first, last = ordered[0], ordered[-1]
        repos.append(
            {
                "repo": repo,
                "days_seen": len(ordered),
                "first_seen": first,
                "last_seen": last,
                "stars_now": entry["stars"].get(last, 0),
                "star_delta": entry["stars"].get(last, 0) - entry["stars"].get(first, 0),
                "peak_daily_gain": entry["gain"],
                "topics": entry["topics"],
                "desc": entry["desc"],
                "class": (
                    "resident"
                    if len(ordered) >= max(MIN_TRUSTED_DAYS, day_count * SUSTAINED_RATIO)
                    else "recurring"
                    if len(ordered) >= 2
                    else "one-off"
                ),
            }
        )

    sustained = sorted(
        (r for r in repos if r["days_seen"] >= 2),
        key=lambda r: (r["days_seen"], r["star_delta"]),
        reverse=True,
    )
    one_day = sorted(
        (r for r in repos if r["days_seen"] == 1 and r["peak_daily_gain"] >= MIN_PEAK_FOR_ONE_DAY),
        key=lambda r: r["peak_daily_gain"],
        reverse=True,
    )
    climbing = sorted(
        (r for r in repos if r["star_delta"] > 0),
        key=lambda r: r["star_delta"],
        reverse=True,
    )

    if day_count < MIN_TRUSTED_DAYS:
        note = f"insufficient data: {day_count} day(s) in window; a trend claim would be unfounded"
    elif missing:
        note = f"usable with gaps: {len(missing)} day(s) missing from the window"
    else:
        note = "window complete"

    return {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "automation": "github-trending-weekly",
        "window": {
            "days": days,
            "from": (dt.date.today() - dt.timedelta(days=days - 1)).isoformat(),
            "to": dt.date.today().isoformat(),
        },
        "days_with_data": day_count,
        "days_missing": missing,
        "trustworthy": day_count >= MIN_TRUSTED_DAYS,
        "note": note,
        "topics_persistent": [t for t in topics if t["verdict"] == "persistent"],
        "topics_emerging": [t for t in topics if t["verdict"] == "emerging"],
        "topics_all": topics[:25],
        "repos_sustained": sustained[:15],
        "repos_climbing_by_stars": climbing[:15],
        "repos_one_day_wonders": one_day[:10],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        default="trending",
        help="directory holding <YYYY-MM-DD>.json snapshots (default: trending)",
    )
    parser.add_argument("--days", type=int, default=7, help="rolling window (default: 7)")
    args = parser.parse_args()

    if not os.path.isdir(args.data_dir):
        sys.stderr.write(f"[error] data directory not found: {args.data_dir}\n")
        return 2
    snapshots, missing = load_snapshots(args.data_dir, args.days)
    if not snapshots:
        available = sorted(os.path.basename(p) for p in glob.glob(os.path.join(args.data_dir, "*.json")))
        sys.stderr.write(
            f"[error] no daily snapshots in {args.data_dir} for the last {args.days} days\n"
            f"        files present: {available or 'none'}\n"
        )
        return 2

    json.dump(aggregate(snapshots, args.days), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
