#!/usr/bin/env python3
"""Check whether a project NAME is findable, and whether it collides or drowns.

Why this exists
---------------
Every other discoverability item measures the repo's *contents*. But a name is
the one field a user types. If the name does not match what people search, none
of the other work gets a chance to matter.

There is no public search-volume data on GitHub — no API reports "how many
people searched this word". What IS measurable:

  * **competition**  how many repos match the name in `in:name`
  * **occupancy**    how many stars the top result has (is the slot taken?)

A 0-star new repo cannot outrank a 2,000-star repo for a crowded term. So the
only reachable position is a name that (a) matches what someone types and
(b) is not already crowded.

Verdicts
--------
    PASS      0–2 near-name repos and the top one is weak  → you can own this
    PASS      3–10 near-name repos                         → usable
    FAIL      >10 near-name repos                          → drowned, rename
    FAIL      top result has ≥1000 stars                    → the slot is taken

"Clinging to a hot ecosystem" is deliberately NOT scored. If the name shares a
prefix with a famous project (e.g. `mole-guard` after `tw93/Mole`), the report
shows that project's star count as context but does not reward or penalise it —
a borrowed prefix only helps if the searcher was already looking for the parent.

Usage:
    python3 naming.py mac-cleanup-guard
    python3 naming.py --owner LyraWang6688              # every public repo
    python3 naming.py --store ~/Documents/workplace/ai-capability-store
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse

CACHE: dict[str, dict] = {}
GENERIC_TOKEN_TEST = 1000  # a token matching this many repos is "generic"


def _gh(path: str):
    completed = subprocess.run(["gh", "api", path], capture_output=True,
                               text=True, timeout=90)
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None


def search(term: str) -> dict:
    """Return {count, top_name, top_star} for `<term> in:name`. Cached."""
    if term in CACHE:
        return CACHE[term]
    qs = urllib.parse.quote(f"{term} in:name", safe="")
    data = _gh(f"search/repositories?q={qs}&sort=stars&per_page=1") or {}
    result = {
        "count": data.get("total_count", 0),
        "top_name": (data.get("items") or [{}])[0].get("full_name", ""),
        "top_star": (data.get("items") or [{}])[0].get("stargazers_count", 0),
    }
    CACHE[term] = result
    time.sleep(2.2)  # 搜索接口上限 30 次/分；每个词 1 次，留足余量
    return result


def tokens(name: str) -> list[str]:
    return [t for t in name.lower().replace("_", "-").split("-") if t]


def analyze(name: str) -> dict:
    """Judge one project name. `name` is the repo slug, not owner/name."""
    full = search(name)
    parts = tokens(name)

    # Which token, if any, is generic on its own? A name built only from generic
    # tokens has nothing to rank on.
    generic = []
    for tok in parts:
        if len(tok) < 3:
            continue
        info = search(tok)
        if info["count"] >= GENERIC_TOKEN_TEST:
            generic.append({"token": tok, "count": info["count"]})

    problems, notes = [], []

    # Only two things are actually measurable, and only these can fail a name.
    #
    # An earlier version also failed a name when *every* token was "generic"
    # (matching >=1000 repos). That was wrong: on GitHub virtually every English
    # word matches thousands of repos, so the rule failed almost everything —
    # including `mac-cleanup-guard`, which has ZERO near-name repos and therefore
    # owns its exact-match slot. Generic tokens are context, not a verdict.

    if full["count"] > 10:
        problems.append(
            f"近名仓库 {full['count']} 个 —— 新仓库排不进前面，考虑加区分词")
    elif full["count"] >= 3:
        notes.append(f"近名仓库 {full['count']} 个 —— 可用，但不算独占")
    else:
        notes.append(
            f"近名仓库 {full['count']} 个 —— 精确匹配这个词就能排第一")

    if full["top_star"] >= 1000:
        problems.append(
            f"这个名字下第一名 {full['top_name']} 有 ⭐{full['top_star']:,} —— 位置已被占")
    elif full["count"] and full["top_star"] <= 50:
        notes.append(
            f"第一名 {full['top_name']} 只有 ⭐{full['top_star']} —— 这个位置抢得下来")

    if generic:
        notes.append(
            "含泛词（" + "、".join(f"{g['token']}({g['count']:,})" for g in generic)
            + "）—— 单独搜这个词轮不到你，你的机会在整串精确匹配")

    # "Clinging to a hot ecosystem" is context, not a score.
    ecosystem = None
    if len(parts) > 1:
        parent = search(parts[0])
        if parent["count"] >= 100 and parent["top_star"] >= 1000:
            ecosystem = {"token": parts[0], "top_name": parent["top_name"],
                         "top_star": parent["top_star"], "count": parent["count"]}

    status = "FAIL" if problems else "PASS"
    return {"name": name, "status": status, "tokens": parts,
            "collisions": full["count"], "top_name": full["top_name"],
            "top_star": full["top_star"], "generic_tokens": generic,
            "ecosystem": ecosystem, "problems": problems, "notes": notes}


def public_repos(owner: str) -> list[str]:
    data = _gh(f"users/{owner}/repos?per_page=100&type=public") or []
    return [r["name"] for r in data if not r.get("archived")]


def store_assets(store: str) -> list[str]:
    """Asset names inside a capability store — they are publishable projects too."""
    names = []
    for sub in ("skills", "external-capabilities"):
        root = os.path.join(store, sub)
        if not os.path.isdir(root):
            continue
        for entry in sorted(os.listdir(root)):
            path = os.path.join(root, entry)
            if not os.path.isdir(path) or entry.startswith("."):
                continue
            if sub == "external-capabilities":
                for child in sorted(os.listdir(path)):
                    cpath = os.path.join(path, child)
                    if os.path.isdir(cpath) and not child.startswith("."):
                        names.append(child)
            else:
                names.append(entry)
    return names


def render(result: dict) -> None:
    icon = "✓" if result["status"] == "PASS" else "✗"
    print(f"  {icon} {result['name']}")
    print(f"      近名 {result['collisions']} 个 · 第一名 "
          f"{result['top_name'] or '—'} ⭐{result['top_star']:,}")
    if result["ecosystem"]:
        e = result["ecosystem"]
        print(f"      生态借势：`{e['token']}` 对应 {e['top_name']} ⭐{e['top_star']:,}"
              f"（{e['count']:,} 个仓库用这个词）—— 只是上下文，不加分也不扣分")
    for p in result["problems"]:
        print(f"      ✗ {p}")
    for n in result["notes"]:
        print(f"      · {n}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("names", nargs="*", help="项目名，例如 mac-cleanup-guard")
    parser.add_argument("--owner", help="审计该账号下所有公开未归档仓库的命名")
    parser.add_argument("--store", help="审计某个 capability store 里的资产命名")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    names = list(args.names)
    if args.owner:
        names += public_repos(args.owner)
    if args.store:
        names += store_assets(os.path.expanduser(args.store))
    if not names:
        parser.print_help()
        return 2

    results = [analyze(n) for n in names]

    if args.json:
        json.dump({"results": results}, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"\n命名可发现性（共 {len(results)} 个）\n")
        for r in results:
            render(r)
        passed = sum(1 for r in results if r["status"] == "PASS")
        print(f"\n  通过 {passed}/{len(results)}")

    return 0 if all(r["status"] == "PASS" for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
