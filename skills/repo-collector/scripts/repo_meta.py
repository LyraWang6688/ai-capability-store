#!/usr/bin/env python3
"""GitHub repository facts — the deterministic fact source for repo-collector.

The skill must NEVER write Stars / Owner / URL from model memory. Model memory
goes stale and cannot be evidence. This script reads the facts from the GitHub
REST API instead, so every "fact" field in a collected record is reproducible.

Usage:
    python3 repo_meta.py <owner/repo> [<owner/repo> ...]

Output:
    JSON array on stdout; one object per repository, in argument order.

Exit codes:
    0  every repository resolved
    2  at least one repository was not found or the input was malformed
    3  GitHub rate-limited or unreachable (no facts were produced)

Environment:
    GITHUB_TOKEN  optional; raises the API rate limit when set.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
API = "https://api.github.com/repos/"


def fail(msg: str, code: int) -> None:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)


def fetch(slug: str) -> dict:
    """Fetch one repository. Returns a fact dict or raises urllib errors."""
    req = urllib.request.Request(
        API + slug,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "repo-collector-skill",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = json.load(resp)
    owner = raw.get("owner") or {}
    return {
        "project": raw.get("full_name"),
        "html_url": raw.get("html_url"),
        "homepage": raw.get("homepage"),
        "owner": owner.get("login"),
        "owner_type": owner.get("type"),
        "stars": raw.get("stargazers_count"),
        "description": raw.get("description"),
        "archived": raw.get("archived"),
        "license": (raw.get("license") or {}).get("spdx_id"),
        "language": raw.get("language"),
        "topics": raw.get("topics") or [],
        "pushed_at": raw.get("pushed_at"),
    }


def main() -> int:
    slugs = sys.argv[1:]
    if not slugs:
        fail("usage: repo_meta.py <owner/repo> [<owner/repo> ...]", 64)

    bad = [s for s in slugs if not REPO_RE.match(s)]
    if bad:
        fail(f"not in owner/repo form: {', '.join(bad)}", 2)

    results, missing, limited = [], [], False
    for slug in slugs:
        try:
            results.append(fetch(slug))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                missing.append(slug)
                continue
            if exc.code in (403, 429):
                limited = True
                break
            fail(f"{slug}: HTTP {exc.code}", 2)
        except urllib.error.URLError as exc:
            fail(f"GitHub unreachable: {exc.reason}", 3)

    if limited:
        fail("GitHub rate limit hit; retry later or set GITHUB_TOKEN", 3)

    json.dump(results, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")

    if missing:
        sys.stderr.write(f"ERROR: repository not found: {', '.join(missing)}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
