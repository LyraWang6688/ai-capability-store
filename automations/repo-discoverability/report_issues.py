#!/usr/bin/env python3
"""Turn audit failures into issues on the repos that own them.

Why issues instead of a report
------------------------------
A report is read once and forgotten. An issue lands in the repo that has to do
the work, gets assigned to whoever owns it, and stays open until it is actually
fixed. The audit already knows exactly which item failed and how to fix it, so
there is no reason for a human to transcribe that into an issue by hand.

Two properties are non-negotiable
---------------------------------
**Idempotent.** Running weekly must not pile up one issue per run. We search for
an existing open issue carrying our marker:

    marker present, still failing   → update the body in place
    marker present, now passing     → close it with a comment  ← the good path
    no marker, failing              → open one
    no marker, passing              → do nothing

**Honest about permissions.** `GITHUB_TOKEN` in Actions can only write to the
repository the workflow runs in. Opening issues on *other* repositories needs a
PAT with `repo` scope. When the token cannot write, we say so per repo instead of
silently reporting success.

Usage:
    python3 report_issues.py --owner LyraWang6688 --dry-run
    python3 report_issues.py --owner LyraWang6688 --create
    python3 report_issues.py LyraWang6688/one-repo --create
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_discoverability as au  # noqa: E402

MARKER = "<!-- repo-discoverability-bot -->"
LABEL = "discoverability"
LABEL_COLOR = "1D76DB"
LABEL_DESC = "由 repo-discoverability 自动开单：发现性体检未通过"


def gh(args, data=None):
    return subprocess.run(["gh", *args], input=data, capture_output=True,
                          text=True, timeout=120)


def gh_json(args):
    r = gh(args)
    if not r.returncode == 0 or not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def failing_items(result: dict) -> list[dict]:
    return [i for i in result["items"] if i["status"] == "FAIL"]


def render_body(result: dict) -> str:
    fails = failing_items(result)
    tier_note = {"T1": "实测项（必修）", "T2": "生态约定（建议）"}
    lines = [
        MARKER,
        "",
        f"`repo-discoverability` 检查了 **{result['total']} 项**，这个仓库当前 **{result['score']}/{result['total']}**。",
        "",
        f"待补 **{len(fails)} 项**：",
        "",
        "| 项 | 层 | 缺什么 | 怎么补 |",
        "| --- | --- | --- | --- |",
    ]
    for item in fails:
        tier = item.get("tier", "T1")
        detail = item.get("detail") or "—"
        fix = (item.get("fix") or "—").replace("|", "\\|")
        lines.append(f"| `{item['code']}` {item['title']} | {tier_note.get(tier, tier)} | {detail} | {fix} |")
    lines += [
        "",
        "---",
        "",
        "### 写 README 和选 topics 的规范",
        "",
        "见 [`MAINTAINER-GUIDE.md`](https://github.com/LyraWang6688/ai-capability-store/blob/main/automations/repo-discoverability/MAINTAINER-GUIDE.md)。",
        "",
        "### 自己跑一遍校验",
        "",
        "```bash",
        "python3 ~/Documents/workplace/ai-capability-store/automations/repo-discoverability/audit_discoverability.py \\",
        f"  {result['repo']}",
        "```",
        "",
        "### 谁来补",
        "",
        "**全部由本仓库负责的 AI 补。** 审计自动化只读不改 —— 它不改本仓库的任何文件。",
        "",
        "| 项 | 怎么补 |",
        "| --- | --- |",
        "| `topics` / `description` | 按规范自己选、自己填 |",
        "| README 正文 | 按规范自己写 |",
        "| `llms.txt` / DSH 徽章 | 规范里有可直接抄的模板 |",
        "",
        f"<sub>本 issue 由 `repo-discoverability` 自动维护：修好后下次检查会**自动关闭**；"
        f"重复运行只更新内容，不会重复开单。</sub>",
    ]
    return "\n".join(lines)


def ensure_label(repo: str) -> None:
    """Create the label if missing. Failure is non-fatal (it may already exist)."""
    gh(["api", "-X", "POST", f"repos/{repo}/labels", "--input", "-"],
       json.dumps({"name": LABEL, "color": LABEL_COLOR, "description": LABEL_DESC}))


def find_open_issue(repo: str) -> dict | None:
    items = gh_json(["api", f"repos/{repo}/issues?state=open&labels={LABEL}&per_page=30"])
    if not isinstance(items, list):
        return None
    for issue in items:
        if issue.get("pull_request"):
            continue
        if MARKER in (issue.get("body") or ""):
            return issue
    return None


def handle(repo: str, result: dict, do_write: bool) -> dict:
    """One repo: open / update / close as needed."""
    fails = failing_items(result)
    outcome = {"repo": repo, "action": "none", "detail": ""}

    if result.get("archived"):
        outcome["detail"] = "归档仓库，跳过"
        return outcome

    issue = find_open_issue(repo)
    if issue is None and not fails:
        outcome["detail"] = "合规，无需开单"
        return outcome

    if fails:
        body = render_body(result)
        if issue:
            outcome["action"] = "update"
            outcome["detail"] = f"#{issue['number']}"
            if do_write:
                r = gh(["api", "-X", "PATCH", f"repos/{repo}/issues/{issue['number']}",
                        "--input", "-"],
                       json.dumps({"title": f"[discoverability] {len(fails)} 项待补",
                                   "body": body}))
                if r.returncode != 0:
                    outcome["action"] = "error"
                    outcome["detail"] = (r.stderr or r.stdout).strip()[:160]
        else:
            outcome["action"] = "create"
            if do_write:
                ensure_label(repo)
                r = gh(["api", "-X", "POST", f"repos/{repo}/issues", "--input", "-"],
                       json.dumps({"title": f"[discoverability] {len(fails)} 项待补",
                                   "body": body, "labels": [LABEL]}))
                if r.returncode == 0:
                    try:
                        outcome["detail"] = f"#{json.loads(r.stdout)['number']}"
                    except Exception:
                        outcome["detail"] = "已创建"
                else:
                    outcome["action"] = "error"
                    outcome["detail"] = (r.stderr or r.stdout).strip()[:160]
        return outcome

    # 之前不合格，现在合格了 → 关闭
    outcome["action"] = "close"
    outcome["detail"] = f"#{issue['number']}（已修复）"
    if do_write:
        gh(["api", "-X", "POST", f"repos/{repo}/issues/{issue['number']}/comments", "--input", "-"],
           json.dumps({"body": f"{MARKER}\n\n✅ 全部检查项已通过，自动关闭。"}))
        r = gh(["api", "-X", "PATCH", f"repos/{repo}/issues/{issue['number']}", "--input", "-"],
               json.dumps({"state": "closed"}))
        if r.returncode != 0:
            outcome["action"] = "error"
            outcome["detail"] = (r.stderr or r.stdout).strip()[:160]
    return outcome


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repos", nargs="*")
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--create", action="store_true",
                        help="真的开/改/关 issue；默认只打印计划")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repos = list(args.repos)
    if not repos:
        listing = gh_json(["api", f"users/{args.owner}/repos?per_page=100&type=public"]) or []
        repos = [r["full_name"] for r in listing if not r.get("archived")]
        skipped = [r["full_name"] for r in listing if r.get("archived")]
    else:
        skipped = []

    outcomes = []
    for repo in repos:
        try:
            result = au.audit(repo)
        except Exception as exc:  # noqa: BLE001 — one bad repo must not kill the run
            outcomes.append({"repo": repo, "action": "error",
                             "detail": f"{type(exc).__name__}: {exc}"})
            continue
        outcomes.append(handle(repo, result, args.create))

    if args.json:
        json.dump({"create": args.create, "outcomes": outcomes}, sys.stdout,
                  ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        print(f"\n{'已执行' if args.create else 'DRY-RUN（加 --create 才动 issue）'}\n")
        icons = {"create": "🆕", "update": "✏️", "close": "✅", "none": "·", "error": "❌"}
        for o in outcomes:
            print(f"  {icons.get(o['action'], '?')} {o['repo']:46s} {o['action']:7s} {o['detail']}")
        if skipped:
            print(f"\n  归档跳过 {len(skipped)} 个：{', '.join(r.split('/')[-1] for r in skipped)}")
        errors = [o for o in outcomes if o["action"] == "error"]
        if errors:
            print(f"\n  ⚠️ {len(errors)} 个失败。最常见原因：没有跨仓库写权限")
            print("     需要 PAT（repo scope），用 GITHUB_TOKEN 只能写当前仓库")

    return 0 if not any(o["action"] == "error" for o in outcomes) else 1


if __name__ == "__main__":
    sys.exit(main())
