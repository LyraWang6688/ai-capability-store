#!/usr/bin/env python3
"""Local asset-review watcher — L1 detect, L2 mechanical scan, L3 agent handoff.

Why local and not a GitHub Action. A workflow can only review what has already been
pushed; by then the context has moved on and a fix costs a switch. This watches the
three registry files, so a newly registered asset is noticed the moment it is saved —
before the commit, before the push. That is the cheapest possible moment to be told
the thing is wrong.

It is not a daemon. launchd runs it every five minutes while the machine is awake,
which is exactly when someone is editing the repository. No background process, no
polling loop, nothing to forget about.

State and reports live outside the repository (~/.ai-capability-store/asset-review)
so the watcher never dirties the tree it is watching.

Usage:
    python3 scripts/asset_review.py            # only what changed since last run
    python3 scripts/asset_review.py --all      # everything, ignoring state
    python3 scripts/asset_review.py --quiet    # no macOS notification
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Overridable so the script can be exercised without touching the real state dir
# (and so a test run cannot silently consume the "what is new" delta).
STATE_DIR = os.path.expanduser(
    os.environ.get("ASSET_REVIEW_HOME", "~/.ai-capability-store/asset-review"))
STATE_PATH = os.path.join(STATE_DIR, "state.json")
REPORT_DIR = os.path.join(STATE_DIR, "reports")
KEEP_REPORTS = 20

REGISTRIES = {
    "skills": ("skills/registry.yaml", "skills"),
    "capabilities": ("external-capabilities/registry.yaml", "capabilities"),
    "automations": ("automations/registry.yaml", "automations"),
}

TEXT_SUFFIXES = {".md", ".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".yaml", ".yml", ".json"}
MAX_SCAN_BYTES = 200_000

# Patterns that have actually mattered in reviews of this repository.
SECRET_PATTERNS = [
    (re.compile(r"(?i)\b(app_?secret|api_?key|access_?token|client_?secret)\b\s*[:=]\s*['\"][A-Za-z0-9_\-]{12,}"), "hardcoded credential"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{20,}"), "npm token"),
    (re.compile(r"\bghp_[A-Za-z0-9]{20,}"), "GitHub token"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), "GitHub fine-grained token"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}"), "API secret key"),
]
RISK_PATTERNS = [
    (re.compile(r"shell\s*:\s*true"), "shell: true — remote or variable text reaches a shell"),
    (re.compile(r"\bexec\s*\(\s*[`\"']"), "exec() with a string — no argv separation"),
    (re.compile(r"child_process"), "spawns subprocesses"),
    (re.compile(r"\bfetch\(|https?://"), "makes network calls"),
]
PATH_PATTERN = re.compile(r"/Users/[A-Za-z0-9._\-]+")


def yaml_load(path):
    try:
        import yaml
    except ImportError:
        sys.exit("PyYAML required: pip install -r requirements-dev.txt")
    try:
        with open(path, encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except (OSError, yaml.YAMLError):
        return {}


def fingerprint(rel_path):
    with open(os.path.join(ROOT, rel_path), "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, STATE_PATH)


def asset_dirs():
    """key -> (domain, implementation directory) for every registered asset."""
    out = {}
    for domain, (rel, section) in REGISTRIES.items():
        reg = yaml_load(os.path.join(ROOT, rel))
        for key, entry in (reg.get(section) or {}).items():
            if not isinstance(entry, dict):
                continue
            impl = entry.get("implementation_path") or entry.get("path")
            if isinstance(impl, str) and impl:
                out[f"{domain}:{key}"] = (domain, key, entry, impl)
    return out


def walk_files(directory):
    base = os.path.join(ROOT, directory)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames
                       if d not in {"node_modules", "__pycache__", ".git", ".venv", "dist-test"}]
        for name in filenames:
            if os.path.splitext(name)[1].lower() in TEXT_SUFFIXES:
                yield os.path.join(dirpath, name)


def scan_asset(domain, key, entry, impl):
    """Mechanical findings. Returns a list of (severity, message)."""
    findings = []
    base = os.path.join(ROOT, impl)
    if not os.path.isdir(base):
        return [("high", f"{impl} 不存在")]
    if not os.path.isfile(os.path.join(base, "README.md")):
        findings.append(("medium", "没有 README.md"))
    if not os.path.isfile(os.path.join(base, ".gitignore")):
        findings.append(("low", "没有 .gitignore"))

    secrets, secrets_fixture, risks, paths = [], [], {}, set()
    for path in walk_files(impl):
        if os.path.getsize(path) > MAX_SCAN_BYTES:
            continue
        try:
            with open(path, encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except OSError:
            continue
        rel = os.path.relpath(path, ROOT)
        # Test fixtures hold fake credentials on purpose. Flagging them as high
        # severity teaches the reader to ignore the high severity — which is the
        # only failure mode a scanner must not have. Downgrade, do not hide.
        is_fixture = bool(re.search(r"(^|/)(tests?|spec|fixtures?|examples?)/", rel))
        for pattern, label in SECRET_PATTERNS:
            if pattern.search(text):
                bucket = secrets_fixture if is_fixture else secrets
                bucket.append(f"{label} @ {rel}")
        for pattern, label in RISK_PATTERNS:
            if pattern.search(text):
                risks[label] = risks.get(label, 0) + 1
        for hit in PATH_PATTERN.findall(text):
            if "/Users/runner/" not in hit and "/Users/wangying" not in hit:
                paths.add(hit)

    findings.extend(("high", f"疑似密钥：{s}") for s in secrets[:5])
    findings.extend(("low", f"测试夹具里的假密钥（正常，仅供确认）：{s}")
                    for s in secrets_fixture[:5])
    for label, n in risks.items():
        sev = "high" if label.startswith(("shell", "exec")) else "medium"
        findings.append((sev, f"{label}（{n} 处）"))
    findings.extend(("medium", f"硬编码本机路径：{p}") for p in list(paths)[:3])
    return findings


def render_report(changed, all_assets):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [f"# 新登记 / 变更的资产 — {now}", ""]
    worst = "low"
    for full_key in changed:
        domain, key, entry, impl = all_assets[full_key]
        version = entry.get("version", "?")
        status = entry.get("status", "?")
        lines.append(f"## {key} — {domain} v{version} ({status})")
        lines.append("")
        lines.append(f"实现目录：`{impl}`")
        lines.append("")
        findings = scan_asset(domain, key, entry, impl)
        if findings:
            order = {"high": 0, "medium": 1, "low": 2}
            for severity, message in sorted(findings, key=lambda f: order[f[0]]):
                mark = {"high": "🔴", "medium": "🟡", "low": "🟢"}[severity]
                lines.append(f"- {mark} {message}")
                if order[severity] < order[worst]:
                    worst = severity
        else:
            lines.append("- ✅ 机械检查无发现")
        lines.append("")

    lines += [
        "## 接下来（语义审查）",
        "",
        "机械检查看不到这些，需要人或者 agent 判断：",
        "",
        "- 这个设计选得对不对，有没有更简单的做法",
        "- 它声明的限制是真的限制，还是没试过",
        "- 有没有「看起来对但会静默失效」的地方",
        "- 和现有资产是否重叠或冲突",
        "",
        "把下面这段直接丢给 DSH 会话：",
        "",
        "```text",
        f"读 {REPORT_DIR} 下最新的报告，对里面列出的每个资产做一次代码审查。",
        "重点看：设计是否成立、声明的限制是否属实、有没有静默失效的地方、",
        "和现有资产是否重叠。结论写成 GitHub Issue 或 PR review（带行号）。",
        "```",
        "",
        f"最严重的发现：{worst}",
        "",
    ]
    return "\n".join(lines), worst


def notify(title, body):
    script = f'display notification {json.dumps(body)} with title {json.dumps(title)}'
    try:
        subprocess.run(["/usr/bin/osascript", "-e", script],
                       capture_output=True, check=False, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def prune_reports():
    try:
        files = sorted(f for f in os.listdir(REPORT_DIR) if f.endswith(".md"))
    except OSError:
        return
    for name in files[:-KEEP_REPORTS]:
        try:
            os.remove(os.path.join(REPORT_DIR, name))
        except OSError:
            pass


def main(argv):
    force_all = "--all" in argv
    quiet = "--quiet" in argv

    assets = asset_dirs()
    state = load_state()

    current = {full: rel for full, (rel, _) in REGISTRIES.items()}
    current = {domain: fingerprint(rel) for domain, (rel, _) in REGISTRIES.items()}

    changed_registries = [d for d, h in current.items() if state.get("registries", {}).get(d) != h]
    if not changed_registries and not force_all:
        return 0  # nothing moved — stay silent, this runs every 5 minutes

    known = set(state.get("assets", []))
    changed = sorted(assets) if force_all else sorted(set(assets) - known)
    if not changed:
        state["registries"] = current
        state["assets"] = sorted(assets)
        save_state(state)
        return 0

    os.makedirs(REPORT_DIR, exist_ok=True)
    report, worst = render_report(changed, assets)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(REPORT_DIR, f"{stamp}.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(report)

    names = ", ".join(c.split(":", 1)[1] for c in changed[:3])
    more = f" 等 {len(changed)} 个" if len(changed) > 3 else ""
    if not quiet:
        notify(f"Store 有新资产：{names}{more}", f"最严重发现：{worst}。报告：{path}")

    print(f"reviewed {len(changed)} asset(s) -> {path}")
    print(f"worst finding: {worst}")

    state["registries"] = current
    state["assets"] = sorted(assets)
    state["last_run"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_state(state)
    prune_reports()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
