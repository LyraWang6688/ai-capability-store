#!/usr/bin/env python3
"""GitHub 公开项目基线审计：逐项检查仓库是否满足基线清单。

结果三态：
    PASS    功能确实开着 / 条件确实满足
    FAIL    功能确实关着 / 条件确实不满足
    UNKNOWN 查不到 —— **不代表没开**（无权限、API 失败、字段缺失）

为什么要有 UNKNOWN：报告的全部价值是「不用自己去核」。
一旦某条 FAIL 其实是查不到，读者就不再信任剩下的条目。

用法：
    python3 scripts/audit_baseline.py <owner/repo> [<owner/repo> ...]
    python3 scripts/audit_baseline.py --all [--owner OWNER]

退出码：0 无 FAIL；1 存在 FAIL（UNKNOWN 不导致失败）
"""
import json
import subprocess
import sys

PASS, FAIL, UNKNOWN = "PASS", "FAIL", "UNKNOWN"

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


def gh2(path):
    """返回 (http_status, data)。status 0 表示进程失败（无 gh / 网络）。"""
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    out = r.stdout or ""
    if out.lstrip().startswith("{"):
        try:
            body = json.loads(out)
            if "status" in body and isinstance(body.get("status"), (int, str)):
                try:
                    return int(body["status"]), None
                except Exception:
                    pass
            return 200, body
        except Exception:
            pass
    if not out.strip():
        return 0, None
    try:
        return 200, json.loads(out)
    except Exception:
        return 0, None


def gh(path):
    return gh2(path)[1]


def list_tree(repo, branch):
    d = gh(f"repos/{repo}/git/trees/{branch}?recursive=1")
    if not isinstance(d, dict) or "tree" not in d:
        return None
    return {x.get("path") for x in (d.get("tree") or [])}


def flag(value):
    """三态转换：None → UNKNOWN，True → PASS，False → FAIL。"""
    if value is None:
        return UNKNOWN
    return PASS if value else FAIL


def audit(repo):
    status, d = gh2(f"repos/{repo}")
    if not isinstance(d, dict) or status != 200:
        return None, "仓库不存在或无权限"
    if d.get("private"):
        return None, "私有仓库（部分安全功能需付费，跳过）"

    # ← review 修正：默认分支不能硬编码 main
    branch = d.get("default_branch") or "main"

    sec = d.get("security_and_analysis")
    sa = sec if isinstance(sec, dict) else {}

    cs = gh(f"repos/{repo}/code-scanning/default-setup")
    rulesets = gh(f"repos/{repo}/rulesets")
    bp = gh(f"repos/{repo}/branches/{branch}/protection")
    wfperm = gh(f"repos/{repo}/actions/permissions/workflow")
    tags = gh(f"repos/{repo}/tags")
    cs_alerts = gh(f"repos/{repo}/code-scanning/alerts?state=open")
    tree = list_tree(repo, branch)

    def sec_flag(key):
        v = sa.get(key)
        if not isinstance(v, dict) or "status" not in v:
            return UNKNOWN
        return PASS if v["status"] == "enabled" else FAIL

    res = {}
    res["A1"] = sec_flag("secret_scanning")
    res["A2"] = sec_flag("secret_scanning_push_protection")
    res["A3"] = sec_flag("dependabot_security_updates")

    if not isinstance(cs, dict) or "state" not in cs:
        res["A5"] = UNKNOWN
    else:
        res["A5"] = PASS if cs["state"] == "configured" else FAIL

    if tree is None:
        for k in ("A6", "B4", "C1", "D1", "D3", "E3"):
            res[k] = UNKNOWN
    else:
        res["A6"] = PASS if ("SECURITY.md" in tree or ".github/SECURITY.md" in tree) else FAIL
        res["B4"] = PASS if (".github/CODEOWNERS" in tree or "CODEOWNERS" in tree) else FAIL
        res["C1"] = PASS if any(x.startswith(".github/workflows/") and x.endswith((".yml", ".yaml"))
                                for x in tree) else FAIL
        res["D1"] = PASS if ".github/pull_request_template.md" in tree else FAIL
        res["D3"] = PASS if (".github/CODEOWNERS" in tree or "CODEOWNERS" in tree) else FAIL
        res["E3"] = PASS if ".github/dependabot.yml" in tree else FAIL

    if not isinstance(wfperm, dict):
        res["A7"] = UNKNOWN
    else:
        res["A7"] = PASS if wfperm.get("default_workflow_permissions") == "read" else FAIL

    res["B1"] = flag(d.get("delete_branch_on_merge"))
    res["B5"] = flag(d.get("allow_auto_merge"))

    if isinstance(rulesets, list):
        has_rs = len(rulesets) > 0
        res["B2"] = PASS if (has_rs or bp) else FAIL
    elif bp:
        res["B2"] = PASS
    else:
        res["B2"] = UNKNOWN

    if not isinstance(bp, dict):
        res["B3"] = UNKNOWN
        res["B6"] = UNKNOWN
    else:
        rsc = bp.get("required_status_checks") or {}
        res["B3"] = PASS if rsc.get("contexts") else FAIL
        res["B6"] = PASS if (bp.get("required_conversation_resolution") or {}).get("enabled") else FAIL

    if not isinstance(tags, list):
        res["E2"] = UNKNOWN
    else:
        res["E2"] = PASS if len(tags) > 0 else FAIL

    return res, {
        "codeql_alerts": len(cs_alerts) if isinstance(cs_alerts, list) else None,
        "url": d.get("html_url"),
        "branch": branch,
    }


def render(repo, res, extra):
    print(f"\n{'=' * 62}")
    print(f"{repo}   {extra.get('url', '')}   [默认分支 {extra.get('branch')}]")
    print('=' * 62)
    groups = {}
    for iid, grp, name, fix in ITEMS:
        groups.setdefault(grp, []).append((iid, name, fix, res.get(iid)))

    counts = {PASS: 0, FAIL: 0, UNKNOWN: 0}
    for grp, items in groups.items():
        print(f"\n[{grp}]")
        for iid, name, fix, r in items:
            counts[r] += 1
            mark = {PASS: "✓", FAIL: "✗", UNKNOWN: "?"}[r]
            print(f"  {mark} {iid:3} {name}")
            if r == FAIL:
                print(f"        → {fix}")
            elif r == UNKNOWN:
                print("        → 查不到（**不代表没开**）")

    n = extra.get("codeql_alerts")
    print(f"\n未关闭 CodeQL 告警: {n if n is not None else '—'}")
    print(f"结果: PASS {counts[PASS]} · FAIL {counts[FAIL]} · UNKNOWN {counts[UNKNOWN]}")
    if counts[UNKNOWN]:
        print("  UNKNOWN 不代表没开 —— 是这次查不到（权限/API/字段缺失）。")
    extra["fail"] = counts[FAIL]
    return counts[FAIL] == 0


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
        summary.append((repo, extra.get("fail", 0)))

    if len(summary) > 1:
        print("\n" + "=" * 62)
        print("汇总（按 FAIL 数升序）")
        print("=" * 62)
        for repo, f in sorted(summary, key=lambda x: x[1]):
            print(f"  {repo:44} FAIL {f}")
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
