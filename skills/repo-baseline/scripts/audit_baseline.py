#!/usr/bin/env python3
"""GitHub 公开项目基线审计：逐项检查仓库是否满足基线清单。

用法：
    python3 scripts/audit_baseline.py <owner/repo> [<owner/repo> ...]
    python3 scripts/audit_baseline.py --all [--owner OWNER]

退出码：0 全部 PASS 或 N/A；1 存在 FAIL
"""
import json
import subprocess
import sys

# 每项：(编号, 组, 名称, 修复提示)
ITEMS = [
    ("A1", "安全", "密钥扫描 secret scanning", "Settings → Code security → Secret scanning"),
    ("A2", "安全", "推送保护 push protection", "Settings → Code security → Push protection（真 Hook，服务端拦截）"),
    ("A3", "安全", "Dependabot 安全更新", "Settings → Code security → Dependabot security updates"),
    ("A5", "安全", "CodeQL 默认设置", "Settings → Code security → Code scanning → Default setup → Configure"),
    ("A6", "安全", "SECURITY.md 存在", "新建 SECURITY.md 说明漏洞报告渠道"),
    ("A7", "安全", "Actions 默认权限只读", "Settings → Actions → Workflow permissions → Read repository contents"),
    ("B1", "合并", "合并后自动删除分支", "Settings → General → ✅ Automatically delete head branches"),
    ("B2", "合并", "main 分支保护 / Ruleset", "Settings → Rules → New ruleset（禁删除/禁 force push/必须 PR）"),
    ("B3", "合并", "required status checks", "在 Ruleset 中绑定 CI 检查（前提：仓库已有 CI）"),
    ("B4", "合并", "review 要求或 CODEOWNERS", "required_approving_review_count ≥ 1，或添加 .github/CODEOWNERS"),
    ("B5", "合并", "允许 auto-merge", "Settings → General → Allow auto-merge"),
    ("B6", "合并", "对话必须解决", "Ruleset → Require conversation resolution"),
    ("C1", "CI", "有真实 CI workflow", "在 .github/workflows/ 添加真正执行命令的 workflow"),
    ("D1", "可维护", "PR 模板", "新建 .github/pull_request_template.md"),
    ("D3", "可维护", "CODEOWNERS", "新建 .github/CODEOWNERS"),
    ("E2", "可扩展", "Releases + Tags", "gh release create / git tag"),
    ("E3", "可扩展", "Dependabot 版本更新配置", "新建 .github/dependabot.yml"),
]


def gh(path, raw=False):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    if raw:
        return r.stdout
    try:
        return json.loads(r.stdout)
    except Exception:
        return None


def exists(repo, path):
    r = subprocess.run(["gh", "api", f"repos/{repo}/contents/{path}"],
                       capture_output=True, text=True)
    return r.returncode == 0


def audit(repo):
    d = gh(f"repos/{repo}") or {}
    if not d:
        return None, "仓库不存在或无权限"
    if d.get("private"):
        return None, "私有仓库（部分安全功能需付费，跳过）"

    sec = d.get("security_and_analysis") or {}
    cs = gh(f"repos/{repo}/code-scanning/default-setup") or {}
    rulesets = gh(f"repos/{repo}/rulesets")
    bp = gh(f"repos/{repo}/branches/main/protection") or {}
    wfperm = gh(f"repos/{repo}/actions/permissions/workflow") or {}
    workflows = gh(f"repos/{repo}/contents/.github/workflows") or []
    tags = gh(f"repos/{repo}/tags") or []
    releases = gh(f"repos/{repo}/releases") or []
    cs_alerts = gh(f"repos/{repo}/code-scanning/alerts?state=open")

    has_wf = isinstance(workflows, list) and any(
        w.get("name", "").endswith((".yml", ".yaml")) for w in workflows
    )

    res = {}
    res["A1"] = (sec.get("secret_scanning") or {}).get("status") == "enabled"
    res["A2"] = (sec.get("secret_scanning_push_protection") or {}).get("status") == "enabled"
    res["A3"] = (sec.get("dependabot_security_updates") or {}).get("status") == "enabled"
    res["A5"] = cs.get("state") == "configured"
    res["A6"] = exists(repo, "SECURITY.md") or exists(repo, ".github/SECURITY.md")
    res["A7"] = wfperm.get("default_workflow_permissions") == "read"
    res["B1"] = bool(d.get("delete_branch_on_merge"))
    res["B2"] = (isinstance(rulesets, list) and len(rulesets) > 0) or bool(bp)
    rsc = (bp.get("required_status_checks") or {})
    rsc_contexts = rsc.get("contexts") if isinstance(rsc, dict) else None
    res["B3"] = bool(rsc_contexts)
    res["B4"] = bool(exists(repo, ".github/CODEOWNERS") or exists(repo, "CODEOWNERS"))
    res["B5"] = bool(d.get("allow_auto_merge"))
    res["B6"] = bool((bp.get("required_conversation_resolution") or {}).get("enabled"))
    res["C1"] = has_wf
    res["D1"] = exists(repo, ".github/pull_request_template.md")
    res["D3"] = exists(repo, ".github/CODEOWNERS") or exists(repo, "CODEOWNERS")
    res["E2"] = (len(tags) > 0) if isinstance(tags, list) else False
    res["E3"] = exists(repo, ".github/dependabot.yml")

    extra = {
        "codeql_alerts": len(cs_alerts) if isinstance(cs_alerts, list) else None,
        "url": d.get("html_url"),
    }
    return res, extra


def render(repo, res, extra):
    print(f"\n{'=' * 60}")
    print(f"{repo}   {extra.get('url', '')}")
    print('=' * 60)
    groups = {}
    for iid, grp, name, fix in ITEMS:
        groups.setdefault(grp, []).append((iid, name, fix, res.get(iid)))

    total = passed = 0
    for grp, items in groups.items():
        print(f"\n[{grp}]")
        for iid, name, fix, ok in items:
            total += 1
            if ok:
                passed += 1
                print(f"  ✓ {iid:3} {name}")
            else:
                print(f"  ✗ {iid:3} {name}")
                print(f"        → {fix}")

    n = extra.get("codeql_alerts")
    print(f"\n未关闭 CodeQL 告警: {n if n is not None else '—'}")
    print(f"得分: {passed}/{total}")

    extra["passed"], extra["total"] = passed, total
    return passed == total


def parse_targets(argv):
    if "--all" in argv:
        owner = "LyraWang6688"
        if "--owner" in argv:
            owner = argv[argv.index("--owner") + 1]
        r = subprocess.run(["gh", "repo", "list", owner, "--limit", "100",
                            "--json", "nameWithOwner,isPrivate"], capture_output=True, text=True)
        try:
            repos = json.loads(r.stdout)
        except Exception:
            return []
        return [x["nameWithOwner"] for x in repos if not x.get("isPrivate")]
    return [a for a in argv if not a.startswith("--") and "/" in a]


def main():
    targets = parse_targets(sys.argv[1:])
    if not targets:
        print(__doc__)
        return 1
    any_fail = False
    summary = []
    for repo in targets:
        res, extra = audit(repo)
        if res is None:
            print(f"\n[{repo}] 跳过：{extra}")
            continue
        if not render(repo, res, extra):
            any_fail = True
        summary.append((repo, extra.get("passed", 0), extra.get("total", 0)))

    if len(summary) > 1:
        print("\n" + "=" * 60)
        print("汇总")
        print("=" * 60)
        for repo, p, t in sorted(summary, key=lambda x: -x[1]):
            print(f"  {repo:42} {p:2}/{t}")
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
