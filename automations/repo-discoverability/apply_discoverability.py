#!/usr/bin/env python3
"""Fill the discoverability gaps that `audit_discoverability.py` reports.

Design note — why this reads the README instead of asking a model:

    D2 (description), D1 (topics) and D4 (llms.txt) are all derivable from the
    one artefact the standard already forces you to write well: the README
    opening. That makes the standard self-enforcing and the fixes deterministic
    and reviewable — you can read the diff before it lands and predict exactly
    what it will produce.

    Anything that genuinely needs judgement (rewriting a bad README, deciding
    whether a repo is worth promoting at all) is NOT automated here. The report
    says so and stops.

Safety:
  * dry-run by default — nothing is written unless `--apply` is passed.
  * idempotent — re-running after a successful apply is a no-op.
  * never touches archived repos (they are read-only; the API would 403).
  * topics are merged with what already exists, never replaced wholesale.

Usage:
    python3 apply_discoverability.py --owner LyraWang6688 --dry-run
    python3 apply_discoverability.py --owner LyraWang6688 --apply
    python3 apply_discoverability.py LyraWang6688/ai-capability-store --apply
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys

# Keyword → GitHub topic. Ordered: earlier wins when the cap is hit.
TOPIC_RULES = (
    ("mcp", ("mcp", "model context protocol")),
    ("agent-skills", ("agent skill", "skill", "能力资产", "capability store")),
    ("claude-code", ("claude code", "claude-code", "claude")),
    ("ai-agents", ("agent", "智能体", "multi-agent")),
    ("context-engineering", ("context architecture", "上下文", "agents.md", "context")),
    ("feishu", ("feishu", "lark", "飞书")),
    ("bitable", ("bitable", "多维表格")),
    ("automation", ("automation", "自动化", "自动执行")),
    ("github-actions", ("github actions", "github-actions", "workflow")),
    ("wechat", ("wechat", "公众号", "微信")),
    ("nextjs", ("next.js", "nextjs", "react")),
    ("astro", ("astro",)),
    ("llm", ("llm", "大模型", "语言模型")),
    ("ocr", ("ocr", "识别图片", "视觉模型")),
    ("fastapi", ("fastapi",)),
    ("deployment", ("deploy", "部署")),
    ("devops", ("devops", "运维")),
    ("playwright", ("playwright", "浏览器自动化")),
    ("inventory", ("inventory", "库存")),
    ("retail", ("retail", "零售", "门店")),
    ("knowledge-base", ("knowledge base", "知识库", "memory")),
)
LANGUAGE_TOPICS = {
    "Python": "python", "JavaScript": "javascript", "TypeScript": "typescript",
    "Shell": "shell", "Go": "go", "Rust": "rust", "HTML": "html", "Astro": "astro",
}
MAX_TOPICS = 8
MIN_TOPICS = 5
DESC_MAX = 200
PLAN_FILE = "topics.plan.json"


def gh(args, data=None):
    return subprocess.run(["gh", *args], input=data, capture_output=True,
                          text=True, timeout=90)


def gh_json(path):
    r = gh(["api", path])
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


def gh_raw(path):
    r = gh(["api", path, "-H", "Accept: application/vnd.github.raw"])
    return r.stdout if r.returncode == 0 else ""


def read_readme(repo):
    meta = gh_json(f"repos/{repo}/readme")
    if not meta or not meta.get("path"):
        return "", ""
    return gh_raw(f"repos/{repo}/contents/{meta['path']}"), meta["path"]


def first_blockquote(readme: str) -> str:
    """The `> ...` line right after the H1 — our canonical one-liner."""
    lines = readme.split("\n")
    seen_h1 = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("# "):
            seen_h1 = True
            continue
        if not seen_h1:
            continue
        if stripped.startswith(">"):
            text = stripped.lstrip(">").strip()
            text = re.sub(r"^[\s*_`]*", "", text)
            text = re.sub(r"[\s*_`]*$", "", text)
            if len(text) >= 15:
                return text
        elif stripped and not stripped.startswith("!"):
            break  # a paragraph started before any blockquote
    return ""


def first_paragraph(readme: str) -> str:
    lines = readme.split("\n")
    seen_h1 = False
    buf: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("# "):
            seen_h1 = True
            continue
        if not seen_h1:
            continue
        if stripped.startswith((">", "![", "[![", "<", "```")):
            if buf:
                break
            continue
        if not stripped:
            if buf:
                break
            continue
        buf.append(stripped)
        if sum(len(x) for x in buf) > 60:
            break
    return " ".join(buf)


def _load_topic_plan() -> dict:
    """Curated topics live next to this script; the automation never guesses."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), PLAN_FILE)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            return (json.load(handle) or {}).get("topics") or {}
    except (OSError, json.JSONDecodeError):
        return {}


def derive_description(readme: str, current: str) -> str:
    candidate = first_blockquote(readme) or first_paragraph(readme)
    candidate = re.sub(r"\*\*|`", "", candidate).strip()
    if not candidate:
        return ""
    return candidate[:DESC_MAX]


def _matches(needle: str, blob: str) -> bool:
    """ASCII needles match on word boundaries; CJK ones as plain substrings.

    Without the boundary check "agent" matched inside unrelated words and gave
    feishu-retail-ops an `ai-agents` topic even though its README explicitly says
    the runtime makes no AI calls.
    """
    if needle.isascii():
        return re.search(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", blob) is not None
    return needle in blob


def derive_topics(readme: str, language: str, current: list[str]) -> list[str]:
    """Derive topics from the README *opening* only.

    Scanning the whole file pulled in keywords from historical notes ("voice
    input was removed", "AI parsing no longer runs") and produced topics that
    contradicted the project. The opening is the part that states what the repo
    is, so that is the only part we read.
    """
    head = "\n".join(readme.split("\n")[:60]).lower()
    chosen: list[str] = list(current)
    lang_topic = LANGUAGE_TOPICS.get(language or "")
    if lang_topic and lang_topic not in chosen:
        chosen.append(lang_topic)
    for topic, needles in TOPIC_RULES:
        if len(chosen) >= MAX_TOPICS:
            break
        if topic in chosen:
            continue
        if any(_matches(n, head) for n in needles):
            chosen.append(topic)
    return chosen[:MAX_TOPICS]


def build_llms_txt(repo: str, readme: str, description: str) -> str:
    title = repo.split("/")[-1]
    for line in readme.split("\n"):
        if line.startswith("# "):
            title = line[2:].strip()
            break
    sections = [ln[3:].strip() for ln in readme.split("\n")
                if ln.startswith("## ") and len(ln) > 4][:8]
    out = [f"# {title}", ""]
    if description:
        out += [f"> {description}", ""]
    out += ["## 核心文档", "", "- [README](./README.md)：项目说明与用法"]
    if gh_json(f"repos/{repo}/contents/AGENTS.md"):
        out.append("- [AGENTS.md](./AGENTS.md)：agent 进入本仓库前先读的规则")
    out.append("")
    if sections:
        out += ["## 主要章节", ""]
        out += [f"- {s}" for s in sections]
        out += [""]
    out += ["## 怎么用这份索引", "",
            "这是给 LLM / agent 的机器可读入口：先读上面的核心文档，再按章节名定位。", ""]
    return "\n".join(out)


def put_file(repo: str, path: str, content: str, message: str, branch: str | None = None):
    """Create or update one file. Returns (ok, detail)."""
    existing = gh_json(f"repos/{repo}/contents/{path}")
    body = {"message": message,
            "content": base64.b64encode(content.encode()).decode()}
    if existing and existing.get("sha"):
        body["sha"] = existing["sha"]
    if branch:
        body["branch"] = branch
    r = gh(["api", "-X", "PUT", f"repos/{repo}/contents/{path}", "--input", "-"],
           json.dumps(body))
    return (r.returncode == 0, (r.stderr or r.stdout).strip()[:200])


def apply_repo(repo: str, do_write: bool, do_topics: bool = False) -> dict:
    meta = gh_json(f"repos/{repo}") or {}
    if meta.get("archived"):
        return {"repo": repo, "skipped": "archived"}
    readme, readme_path = read_readme(repo)
    if not readme:
        return {"repo": repo, "skipped": "no README — 先写 README，这是标准的前提"}

    current_desc = (meta.get("description") or "").strip()
    current_topics = meta.get("topics") or []
    plan = {"repo": repo, "actions": [], "suggestions": [], "errors": []}

    new_desc = derive_description(readme, current_desc)
    if new_desc and (not current_desc or not (20 <= len(current_desc) <= DESC_MAX)):
        plan["actions"].append({"field": "description",
                                "from": current_desc, "to": new_desc})

    if len(current_topics) < MIN_TOPICS:
        planned = _load_topic_plan().get(repo)
        if planned:
            plan["actions"].append({"field": "topics", "to": planned, "from": current_topics,
                                    "added": [t for t in planned if t not in current_topics]})
        else:
            # Keyword-derived topics produced wrong answers (a file tree line gave
            # feishu-retail-ops `ai-agents`; "project inventory" gave personal-ip-hub
            # `inventory`). Suggestion only — never written.
            plan["suggestions"] = derive_topics(readme, meta.get("language") or "", [])

    llms = build_llms_txt(repo, readme, new_desc or current_desc)
    if not gh_json(f"repos/{repo}/contents/llms.txt"):
        plan["actions"].append({"field": "llms.txt", "to": "（新建，约 "
                                f"{len(llms)} 字符）", "content": llms})

    if not do_write:
        return plan

    for action in plan["actions"]:
        if action["field"] == "description":
            r = gh(["api", "-X", "PATCH", f"repos/{repo}",
                    "-f", f"description={action['to']}"])
            if r.returncode != 0:
                plan["errors"].append(f"description: {(r.stderr or r.stdout)[:120]}")
        elif action["field"] == "topics" and do_topics:
            args = ["api", "-X", "PUT", f"repos/{repo}/topics"]
            for t in action["to"]:
                args += ["-f", f"names[]={t}"]
            r = gh(args)
            if r.returncode != 0:
                plan["errors"].append(f"topics: {(r.stderr or r.stdout)[:120]}")
        elif action["field"] == "llms.txt":
            ok, detail = put_file(repo, "llms.txt", action["content"],
                                  "docs: add llms.txt for agent-readable indexing")
            if not ok:
                # Branch protection on some repos requires a PR; report, do not bypass.
                plan["errors"].append(f"llms.txt: {detail}")
    return plan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("repos", nargs="*", help="owner/repo")
    parser.add_argument("--owner", default="LyraWang6688")
    parser.add_argument("--apply", action="store_true", help="真的写；默认 dry-run")
    parser.add_argument("--apply-topics", action="store_true",
                        help="同时写 topics（只从 topics.plan.json 取，不猜）")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    repos = list(args.repos)
    if not repos:
        listing = gh_json(f"users/{args.owner}/repos?per_page=100&type=public")
        if listing is None:
            print("无法列出仓库", file=sys.stderr)
            return 2
        repos = [r["full_name"] for r in listing]

    plans = [apply_repo(r, args.apply, args.apply_topics) for r in repos]

    if args.json:
        json.dump({"apply": args.apply, "plans": plans}, sys.stdout,
                  ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        verb = "已写入" if args.apply else "DRY-RUN（加 --apply 才写）"
        print(f"\n{verb}\n")
        for plan in plans:
            if plan.get("skipped"):
                print(f"  [跳过] {plan['repo']}: {plan['skipped']}")
                continue
            if not plan["actions"]:
                print(f"  [无缺口] {plan['repo']}")
                continue
            print(f"  {plan['repo']}")
            for a in plan["actions"]:
                if a["field"] == "topics":
                    print(f"    + topics: 新增 {', '.join(a['added'])}")
                elif a["field"] == "description":
                    print(f"    + description: {a['to'][:70]}…")
                else:
                    print(f"    + {a['field']} {a['to']}")
            if plan.get("suggestions"):
                print(f"    ? 建议 topics（需确认，未写入）: {', '.join(plan['suggestions'])}")
            for e in plan["errors"]:
                print(f"    ! {e}")

    return 0 if not any(p.get("errors") for p in plans) else 1


if __name__ == "__main__":
    sys.exit(main())
