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
        D7 traffic      captured separately by `--baseline`; compare later.

    Naming
        D8 name         measured live by `naming.py`: how many repos share this
                        name, and whether the top one already owns the slot.
                        A 0-star repo cannot outrank a 2,000-star one for a
                        crowded term, so the only reachable position is a name
                        that is not crowded and matches what someone types.

Archived repos are skipped entirely: they are read-only, so their score cannot be
improved and counting them as failures only creates noise.

**Private repos use a reduced item set.** A private repo never appears in GitHub
search, so D1 (topics), D2 (description) and D6 (badge) measure nothing — they are
reported as N/A instead of PASS/FAIL. What still matters privately is whether a
human or an agent who *is* given access can read the repo: D3 (README opening),
D4 (llms.txt), D5 (AGENTS.md). The score denominator is PASS+FAIL, so N/A items do
not dilute it.

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
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import naming  # noqa: E402

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


def audit(repo: str, with_naming: bool = True) -> dict:
    """Return {repo, archived, score, items: [{code, title, status, detail, fix}]}."""
    with_naming = with_naming and not os.environ.get("DISCOVERABILITY_SKIP_NAMING")
    meta = gh_json(f"repos/{repo}") or {}
    archived = bool(meta.get("archived"))
    private = bool(meta.get("private"))
    topics = meta.get("topics") or []
    description = (meta.get("description") or "").strip()
    readme = _readme_text(repo)

    items = []

    def add(code, title, ok, detail, fix, tier="T1", applicable=True):
        status = ("PASS" if ok else "FAIL") if applicable else "N/A"
        items.append({"code": code, "title": title, "tier": tier, "status": status,
                      "detail": detail if applicable else "私有仓库不适用",
                      "fix": "" if (ok or not applicable) else fix})

    add("D1", "topics", len(topics) >= MIN_TOPICS,
        f"{len(topics)} 个" + (f"：{', '.join(topics)}" if topics else "（空）"),
        f"至少 {MIN_TOPICS} 个；没 topic 的仓库在 topic: 搜索里命中数为 0",
        applicable=not private)

    add("D2", "description", DESC_MIN <= len(description) <= DESC_MAX,
        (f"{len(description)} 字：{description[:60]}…" if description else "（空）"),
        f"写 {DESC_MIN}–{DESC_MAX} 字，说清「给谁、解决什么」；"
        "这是搜索结果里唯一能读的一句话", applicable=not private)

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
        "**不影响搜索排名**（图片不被 in:readme 索引为文本）",
        tier="T2", applicable=not private)

    # D8 · 命名：名字是用户唯一会打的那个字段。
    if with_naming:
        try:
            verdict = naming.analyze(repo.split("/")[-1])
            detail = (f"近名 {verdict['collisions']} 个 · "
                      f"第一名 {verdict['top_name'] or '—'} ⭐{verdict['top_star']:,}")
            fix = "；".join(verdict["problems"]) if verdict["problems"] else ""
            add("D8", "命名", verdict["status"] == "PASS", detail, fix,
                applicable=not private)
        except Exception as exc:  # noqa: BLE001 — 搜索接口失败不该让整次审计失败
            add("D8", "命名", False, f"检测失败：{type(exc).__name__}",
                "检查 gh 认证与搜索限额（30 次/分）")

    score = sum(1 for i in items if i["status"] == "PASS")
    total = sum(1 for i in items if i["status"] != "N/A")
    return {"repo": repo, "archived": archived, "private": private, "score": score,
            "total": total, "items": items}


def print_report(result: dict) -> None:
    tag = "  [SKIP · 归档仓库，只读]" if result["archived"] else ""
    print(f"\n{'=' * 60}\n{result['repo']}{tag}\n{'=' * 60}")
    for item in result["items"]:
        mark = {"PASS": "✓", "FAIL": "✗"}.get(item["status"], "–")
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
    parser.add_argument("--no-naming", action="store_true",
                        help="跳过 D8 命名检测（省搜索 API 配额）")
    parser.add_argument("--include-private", action="store_true",
                        help="also audit private repos（判据会自动降级："
                             "私有仓库不检查 topics/description/徽章）")
    args = parser.parse_args()

    repos = list(args.repos)
    if args.all:
        # 默认只审计公开仓库：私有仓库不会出现在 GitHub 搜索里，
        # topics/description/徽章 对它测不出任何东西。要审私有仓库用 --include-private。
        listing = gh_json(
            "user/repos?per_page=100&affiliation=owner" if args.include_private
            else f"users/{args.owner}/repos?per_page=100&type=public")
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
            result = audit(repo, with_naming=not args.no_naming)
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
            avg = sum(r["score"] / r["total"] for r in scorable) / len(scorable)
            priv = [r for r in scorable if r.get("private")]
            print(f"\n  平均 {avg * 100:.0f}%（按各自满分归一）")
            print(f"  公开 {len(scorable) - len(priv)} 个 · 私有 {len(priv)} 个 · 归档跳过 {len(results) - len(scorable)} 个")

    failed = any(i["status"] == "FAIL" for r in scorable for i in r["items"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
