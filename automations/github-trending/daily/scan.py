#!/usr/bin/env python3
"""GitHub Trending daily scan — collect facts only, never conclusions.

Three sources, merged and de-duplicated:
  1. https://github.com/trending?since=daily   (carries "stars today" velocity)
  2. https://github.com/trending?since=weekly
  3. gh search repos --created <7d ago> --stars >200

This automation is READ-ONLY on the network and writes nothing except stdout
(or --save-dir when given). It is deliberately incapable of producing an
opinion: judging which repositories matter is done by an Agent in DSH, not here.

Output: one JSON document on stdout.
Exit:   0 on success (degraded sources are reported in `warnings`, never fatal).
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import urllib.request
from collections import Counter

USER_AGENT = "ai-capability-store/github-trending-daily"
HTTP_TIMEOUT = 30
GH_TIMEOUT = 90
NEW_REPO_DAYS = 7
NEW_REPO_MIN_STARS = 200
TOPIC_MIN_REPOS = 2

# The DSH plugin watchlist. Trending only surfaces what is already popular, so an
# early-stage ecosystem barely appears there — relying on it would make the
# watchlist lucky rather than complete. This is a standing inventory, so it is
# emitted as its own field and never merged into `candidates`: a repo that is not
# trending should not enter topic_frequency.
DSH_TOPIC = "dsh-plugin"
DSH_TOPIC_LIMIT = 50
DSH_TOPIC_TOPICS_FETCH = 10

# NOTE: this module deliberately knows nothing about the owner's curated list.
# "Is this repo already collected?" is an *analysis*-side judgement (it needs the
# Feishu table), so it lives in REPORT-CONTRACT.md §2, not here. Keeping the
# collector neutral also means the curated list can grow without a code change.

# Noise heuristic: obvious non-fits that would otherwise crowd the top of the
# velocity ranking. A very high single-day gain overrides the filter.
NOISE_MARKERS = (
    "job-search", "interview", "leetcode", "java-guide", "awesome-",
    "tutorial", "course", "cheatsheet", "roadmap", "netdisk",
)

REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def _clean(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", "", fragment or "")
    return html.unescape(re.sub(r"\s+", " ", text)).strip()


def _to_int(value: str) -> int:
    try:
        return int(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return 0


def _fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return response.read().decode("utf-8", "ignore")


def parse_trending(period: str) -> list[dict]:
    """Parse one trending page. Structure changes over time, so every field is
    optional except the repository name — a missing field degrades, never raises."""
    page = _fetch(f"https://github.com/trending?since={period}")
    found: list[dict] = []
    for article in re.findall(r"<article[^>]*>(.*?)</article>", page, re.S):
        match = re.search(r'<h2[^>]*>.*?href="/([^"]+)"', article, re.S)
        if not match:
            continue
        repo = match.group(1).strip()
        if not REPO_RE.match(repo):
            continue
        desc_match = re.search(
            r'<p[^>]*class="[^"]*col-9[^"]*"[^>]*>(.*?)</p>', article, re.S
        )
        star_matches = re.findall(
            r'href="/%s/stargazers"[^>]*>\s*(?:<svg.*?</svg>)?\s*([\d,]+)'
            % re.escape(repo),
            article,
            re.S,
        )
        gain_match = re.search(r"([\d,]+)\s*stars? today", _clean(article))
        lang_match = re.search(r'itemprop="programmingLanguage">([^<]+)<', article)
        found.append(
            {
                "repo": repo,
                "stars": _to_int(star_matches[-1]) if star_matches else 0,
                "trend_gain": _to_int(gain_match.group(1)) if gain_match else None,
                "language": lang_match.group(1) if lang_match else "",
                "desc": _clean(desc_match.group(1)) if desc_match else "",
                "topics": [],
                "source": f"trending-{period}",
            }
        )
    return found


def search_new_repos() -> list[dict]:
    """Newly created repositories with traction. Uses the GitHub CLI, which is
    preinstalled on GitHub-hosted runners and reads GH_TOKEN from the env."""
    since = (dt.date.today() - dt.timedelta(days=NEW_REPO_DAYS)).isoformat()
    command = [
        "gh", "search", "repos",
        "--created", f">{since}",
        "--stars", f">{NEW_REPO_MIN_STARS}",
        "--sort", "stars",
        "--limit", "20",
        # `topics` is NOT an accepted --json field for `gh search repos`
        # (it fails with "Unknown JSON field"). Topics are filled in later by
        # fetch_topics(), which runs for every candidate anyway.
        "--json", "fullName,stargazersCount,description,language",
    ]
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=GH_TIMEOUT
        )
        if completed.returncode != 0:
            return []
        rows = json.loads(completed.stdout or "[]")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return []
    return [
        {
            "repo": row["fullName"],
            "stars": row.get("stargazersCount", 0),
            "trend_gain": None,  # this source carries no daily velocity
            "language": row.get("language") or "",
            "desc": row.get("description") or "",
            "topics": [],
            "source": "new-7d",
        }
        for row in rows
        if REPO_RE.match(row.get("fullName", ""))
    ]


def search_topic(topic: str) -> list[dict]:
    """Repositories explicitly tagged with `topic`.

    Same shape as the other sources, but sourced from the topic index instead of
    the trending page — so it finds a project on day one, not on the day it
    happens to go viral.
    """
    command = [
        "gh", "search", "repos",
        "--topic", topic,
        "--sort", "stars",
        "--limit", str(DSH_TOPIC_LIMIT),
        # `topics` is not an accepted --json field for `gh search repos`;
        # fetch_topics() fills it in below.
        "--json", "fullName,stargazersCount,description,language",
    ]
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=GH_TIMEOUT
        )
        if completed.returncode != 0:
            return []
        rows = json.loads(completed.stdout or "[]")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return []
    return [
        {
            "repo": row["fullName"],
            "stars": row.get("stargazersCount", 0),
            "trend_gain": None,
            "language": row.get("language") or "",
            "desc": row.get("description") or "",
            "topics": [],
            "source": f"topic:{topic}",
        }
        for row in rows
        if REPO_RE.match(row.get("fullName", ""))
    ]


def fetch_topics(repos: list[str]) -> dict[str, list[str]]:
    """Per-repository topics. Sequential on purpose: the call count is bounded
    (<=40) and a burst of parallel unauthenticated calls would hit rate limits."""
    topics: dict[str, list[str]] = {}
    for repo in repos:
        try:
            completed = subprocess.run(
                ["gh", "api", f"repos/{repo}", "--jq", ".topics // []"],
                capture_output=True, text=True, timeout=20,
            )
            topics[repo] = (
                json.loads(completed.stdout)
                if completed.returncode == 0 and completed.stdout.strip()
                else []
            )
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            topics[repo] = []
    return topics


def _max_gain(a: int | None, b: int | None) -> int | None:
    """max() over measured gains only. None means "not measurable" (a source
    without a daily-velocity field), and must never be conflated with 0."""
    values = [v for v in (a, b) if v is not None]
    return max(values) if values else None


def collect(warnings: list[str]) -> tuple[dict[str, dict], int]:
    merged: dict[str, dict] = {}
    for period in ("daily", "weekly"):
        try:
            for item in parse_trending(period):
                existing = merged.get(item["repo"])
                if existing:
                    existing["trend_gain"] = max(
                        existing["trend_gain"], item["trend_gain"]
                    )
                    existing["source"] = "trending-daily+weekly"
                else:
                    merged[item["repo"]] = item
        except Exception as exc:  # noqa: BLE001 — one dead source degrades, never fails
            warnings.append(f"trending-{period}: {type(exc).__name__}: {exc}")
    new_repos = search_new_repos()
    if not new_repos:
        warnings.append("search-new: gh returned nothing (unauthenticated or rate limited)")
    for item in new_repos:
        merged.setdefault(item["repo"], item)
    return merged, len(merged)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--save-dir",
        help="also write <save-dir>/<YYYY-MM-DD>.json (local runs only)",
    )
    args = parser.parse_args()

    warnings: list[str] = []
    merged, scanned = collect(warnings)

    excluded_noise: list[str] = []
    candidates: list[dict] = []
    for repo, item in merged.items():
        blob = f"{repo} {item['desc']}".lower()
        gain = item["trend_gain"]
        if any(marker in blob for marker in NOISE_MARKERS) and (gain is None or gain < 300):
            excluded_noise.append(repo)
            continue
        candidates.append(item)
    candidates.sort(
        key=lambda c: (c["trend_gain"] if c["trend_gain"] is not None else -1, c["stars"]),
        reverse=True,
    )

    dsh_plugins = search_topic(DSH_TOPIC)
    if not dsh_plugins:
        warnings.append(
            f"topic:{DSH_TOPIC}: gh returned nothing (unauthenticated or rate limited)"
        )

    # One topics round-trip covers both lists; dedupe while keeping order.
    seen_repos = [c["repo"] for c in candidates[:40]]
    seen_set = set(seen_repos)
    # Only the head of the watchlist needs topics: the report shows the top few
    # by stars, and 50 sequential gh-api calls would dominate the run time.
    for plugin in dsh_plugins[:DSH_TOPIC_TOPICS_FETCH]:
        if plugin["repo"] not in seen_set:
            seen_repos.append(plugin["repo"])
            seen_set.add(plugin["repo"])
    topics = fetch_topics(seen_repos)
    for candidate in candidates:
        if not candidate.get("topics"):
            candidate["topics"] = topics.get(candidate["repo"], [])
    for plugin in dsh_plugins:
        if not plugin.get("topics"):
            plugin["topics"] = topics.get(plugin["repo"], [])

    frequency = Counter()
    for candidate in candidates:
        for topic in candidate["topics"]:
            frequency[topic] += 1
    topic_frequency = [
        {"topic": topic, "repos": count}
        for topic, count in frequency.most_common(30)
        if count >= TOPIC_MIN_REPOS
    ]

    result = {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "automation": "github-trending-daily",
        "total_scanned": scanned,
        "warnings": warnings,
        "excluded_noise": sorted(excluded_noise),
        "topic_frequency": topic_frequency,
        "dsh_plugins": dsh_plugins,
        "candidates": candidates,
    }

    if args.save_dir:
        os.makedirs(args.save_dir, exist_ok=True)
        stamp = dt.date.today().isoformat()
        with open(
            os.path.join(args.save_dir, f"{stamp}.json"), "w", encoding="utf-8"
        ) as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
