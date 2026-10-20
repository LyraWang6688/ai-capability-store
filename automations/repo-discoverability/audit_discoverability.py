#!/usr/bin/env python3
"""Audit how discoverable a public GitHub repo is — to humans and to AI agents.

Read-only: this script never writes to GitHub.

The checks are deliberately tiered by *how strong the evidence is*, because a
standard nobody can defend is just a list of opinions:

    T1  measured in this workspace
        D1 topics       boolean gate — a repo with 0 topics does not appear in
                        `topic:` search at all. Measured 2026-10-19 on
                        LyraWang6688's repos: 0 hits at 0 topics, 1 hit each
                        after tagging.
        D2 description  the only free text GitHub shows in a search result row.
        D3 readme head  `in:readme` matches 281,371 repos for one probe term vs
                        2,668 for `in:description` — the indexable surface is
                        roughly 100× larger, so the opening lines are what an
                        agent actually reads.

    T2  ecosystem convention (no direct measurement, cheap to add)
        D4 llms.txt     llmstxt.org; both exemplar repos (android/skills,
                        morluto/rea) ship one.
        D5 AGENTS.md    the convention agent tooling already reads.
        D6 dsh badge    attribution + ecosystem traceability, NOT a ranking
                        factor: the badge is an <img>, and GitHub indexes README
                        text, not image contents. Do not expect the score to
                        move traffic.

    T3  needs a 14-day window (GitHub traffic retention)
        D6 traffic      captured separately by `--baseline`; compare later.

Archived repos are reported as SKIP, not FAIL: they are read-only, so their
score cannot be improved and counting them as failures only creates noise.

Usage:
    python3 scripts/audit_discoverability.py LyraWang6688/ai-capability-store
    python3 scripts/audit_discoverability.py --all --owner LyraWang6688
    python3 scripts/audit_discoverability.py --all --owner X --json

Exit codes: 0 all PASS/SKIP, 1 something FAILed, 2 could not run.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

# The three questions a README opening must answer. Chinese and English forms are
# both accepted so a bilingual repo is not penalised.
OPENING_MARKERS = (
    ("给谁用", "who it's for", "who its for", "audience"),
    ("它做什么", "what it does", "what it is", "核心能力", "what problem"),
    ("怎么开始", "get started", "quick start", "quickstart", "install", "usage"),
)

BADGE_MARKERS = ("powered_by-dsh", "powered-by-dsh")
MIN_TOPICS = 5
DESC_MIN, DESC_MAX = 20, 200


def gh_json(path: str):
    completed = subprocess.run(
        ["gh", "api", path], capture_output=True, text=True, timeout=60,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        return None
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return None


def gh_raw(path: str) -> str:
    completed = subprocess.run(
        ["gh", "api", path, "-H", "Accept: application/vnd.github.raw"],
        capture_output=True, text=True, timeout=60,
    )
    return completed.stdout if completed.returncode == 0 else ""


def _readme_text(repo: str) -> str:
    """Return the README body, or '' when there is none."""
    meta = gh_json(f"repos/{repo}/readme")
    if not meta or not meta.get("path"):
        return ""
    return gh_raw(f"repos/{repo}/contents/{meta['path']}")


def _has_file(repo: str, path: str) -> bool:
    return gh_json(f"repos/{repo}/contents/{path}") is not None


def audit(repo: str) -> dict:
    """Return {repo, archived, score, items: [{code, title, status, detail, fix}]}."""
    meta = gh_json(f"repos/{repo}") or {}
    archived = bool(meta.get("archived"))
    topics = meta.get("topics") or []
    description = (meta.get("description") or "").strip()
    readme = _readme_text(repo)

    items = []

    def add(code, title, ok, detail, fix, tier="T1"):
        items.append({"code": code, "title": title, "tier": tier,
                      "status": "PASS" if ok else "FAIL",
                      "detail": detail, "fix": "" if ok else fix})

    add("D1", "topics", len(topics) >= MIN_TOPICS,
        f"{len(topics)} 个" + (f"：{', '.join(topics)}" if topics else "（空）"),
        f"至少 {MIN_TOPICS} 个；没 topic 的仓库在 topic: 搜索里命中数为 0")

    add("D2", "description", DESC_MIN <= len(description) <= DESC_MAX,
        (f"{len(description)} 字：{description[:60]}…" if description else "（空）"),
        f"写 {DESC_MIN}–{DESC_MAX} 字，说清「给谁、解决什么」；"
        "这是搜索结果里唯一能读的一句话")

    head = "\n".join(readme.split("\n")[:25]).lower()
    found = [any(m.lower() in head for m in group) for group in OPENING_MARKERS]
    add("D3", "README 前三行", all(found),
        f"命中 {sum(found)}/3（给谁用 / 做什么 / 怎么开始）",
        "在标题下插入三行摘要；README 是 GitHub 搜索最大的可索引面")

    add("D4", "llms.txt", _has_file(repo, "llms.txt"), "",
        "新增 llms.txt：给 agent 的机器可读索引（项目是什么 / 核心文档在哪）", tier="T2")

    add("D5", "AGENTS.md", _has_file(repo, "AGENTS.md"), "",
        "新增 AGENTS.md：agent 进入仓库后先读的规则文件", tier="T2")

    badge = any(marker in readme.lower() for marker in BADGE_MARKERS)
    add("D6", "DSH badge", badge, "",
        "README 末尾加 powered-by-dsh 徽章；作用是署名和生态可追溯，"
        "**不影响搜索排名**（图片不被 in:readme 索引为文本）", tier="T2")

    score = sum(1 for i in items if i["status"] == "PASS")
    return {"repo": repo, "archived": archived, "score": score,
            "total": len(items), "items": items}


def print_report(result: dict) -> None:
    tag = "  [SKIP · 归档仓库，只读]" if result["archived"] else ""
    print(f"\n{'=' * 60}\n{result['repo']}{tag}\n{'=' * 60}")
    for item in result["items"]:
        mark = "✓" if item["status"] == "PASS" else "✗"
        tier = item.get("tier", "")
        line = f"  {mark} {item['code']}  {item['title']}" + (f"  [{tier}]" if tier == "T2" else "")
        if item["detail"]:
            line += f"  —  {item['detail']}"
        print(line)
        if item["fix"]:
            print(f"       → {item['fix']}")
    print(f"\n  得分: {result['score']}/{result['total']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repos", nargs="*", help="owner/repo")
    parser.add_argument("--all", action="store_true", help="audit every public repo of --owner")
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--include-archived", action="store_true",
                        help="score archived repos too instead of skipping them")
    args = parser.parse_args()

    repos = list(args.repos)
    if args.all:
        listing = gh_json(f"users/{args.owner}/repos?per_page=100&type=public")
        if listing is None:
            print("无法列出仓库（gh 未认证或网络问题）", file=sys.stderr)
            return 2
        repos.extend(r["full_name"] for r in listing)

    if not repos:
        parser.print_help()
        return 2

    results = []
    for repo in repos:
        try:
            result = audit(repo)
        except Exception as exc:  # noqa: BLE001 — one bad repo must not kill the run
            print(f"[warn] {repo}: {type(exc).__name__}: {exc}", file=sys.stderr)
            continue
        results.append(result)

    scorable = [r for r in results if args.include_archived or not r["archived"]]
    if args.json:
        payload = {
            "owner": args.owner,
            "results": results,
            "summary": {
                "repos": len(results),
                "scored": len(scorable),
                "archived_skipped": len(results) - len(scorable),
                "average_score": round(
                    sum(r["score"] for r in scorable) / len(scorable), 2
                ) if scorable else 0,
            },
        }
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        for result in results:
            if result["archived"] and not args.include_archived:
                print(f"\n  [SKIP] {result['repo']}  归档仓库，只读，跳过")
                continue
            print_report(result)
        if scorable:
            print(f"\n{'=' * 60}\n  汇总（不含归档）\n{'=' * 60}")
            for r in sorted(scorable, key=lambda x: -x["score"]):
                print(f"    {r['score']}/{r['total']}  {r['repo']}")
            avg = sum(r["score"] for r in scorable) / len(scorable)
            print(f"\n  平均 {avg:.2f}/{scorable[0]['total']}")
            print(f"  归档跳过 {len(results) - len(scorable)} 个")

    failed = any(i["status"] == "FAIL" for r in scorable for i in r["items"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
