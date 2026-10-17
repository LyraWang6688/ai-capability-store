#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub Portfolio Snapshot — 个人 GitHub 资产月度治理快照

定位
----
这不是"备份仓库代码"，而是按月给整个 GitHub 账号做一次**资产体检**：
把客观事实（仓库数、提交、PR、release、活跃度）和治理判断（Keep / Archive /
Delete）放在一起，并且**和上一次快照做差分**，回答一个只有时间序列才能回答的问题：

    我这个月，是在积累资产，还是在积累负债？

数据边界（重要）
----------------
- 脚本只写**客观事实**，绝不覆盖策展层里人工写的判断。
- 策展层（Repository Inventory → Repository Registry）是只读的 source of truth，
  脚本读它、join 进快照，并报告"治理漂移"（标了 Keep 却半年没动之类）。
- 唯一写入目标是本脚本自己创建/维护的两张表：
    · Repo Snapshot History  —— 一行 = 一个仓库的一个月
    · Snapshot Runs          —— 一行 = 一次运行（月度叙事摘要 + 计数器）
  现有的「GitHub Snapshot」表原样保留，作为 2026-10-02 治理基线（并充当首次差分的锚点）。

用法
----
    python3 snapshot.py --dry-run              # 只计算、只打印，不写飞书
    python3 snapshot.py                        # 正式写入当月快照
    python3 snapshot.py --period 2026-11       # 指定快照期间
    python3 snapshot.py --force                # 覆盖当月已有快照
    python3 snapshot.py --no-base              # 跳过所有飞书写入（离线自检）

依赖：gh（已登录）、lark-cli（user 身份已授权 base 读写）、Python 3.9+ 标准库。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

# --------------------------------------------------------------------------- #
# 常量与配置
# --------------------------------------------------------------------------- #

# Code lives in the Store; STATE lives in a work directory the operator owns.
#
# Why split: config.json carries this Store's Base token and a personal GitHub
# login, and launchd writes its logs next to it. Keeping state beside the code
# would put both inside a public repository. GITHUB_SNAPSHOT_HOME lets a launchd
# job point at the same work directory it has always used, so migrating the code
# moves no data.
WORK_DIR = Path(
    os.environ.get("GITHUB_SNAPSHOT_HOME")
    or (Path.home() / ".automation-state" / "github-portfolio-snapshot")
)
CONFIG_PATH = WORK_DIR / "config.json"
TZ = ZoneInfo("Asia/Shanghai")
EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\uFE0F\u2B00-\u2BFF]+"
)

# Defaults carry STRUCTURE only. Anything identifying a particular tenant — the
# GitHub login, the Feishu Base, its table ids — has no default on purpose: this
# file is public, and a shipped default would silently point a new operator at
# someone else's data. Supply them in <work-dir>/config.json (see
# config.example.json); load_config() refuses to start without the required ones.
DEFAULT_CONFIG = {
    # ---- REQUIRED: no default, must come from config.json ----
    "github_login": "",        # 被快照的 GitHub 用户名
    "base_token": "",          # 接收快照的飞书 Base token
    "registry_table": "",      # 该 Base 内的策展注册表 table id
    # ---- Optional structural defaults ----
    "base_title": "项目管理",
    # 策展层（只读；留空表示该 Base 没有这张表）
    "inventory_table": None,   # Repository Inventory
    "baseline_table": None,    # 治理基线快照表
    # 事实层（本脚本维护）
    "history_table_name": "Repo Snapshot History",
    "runs_table_name": "Snapshot Runs",
    # 活跃度分档（天）
    "activity_buckets": {"active": 30, "cooling": 90, "stale": 180},
    # Repository Status -> lifecycle_action 的映射（Registry 里的 GitHub Action 是操作处方，
    # 不是 Keep/Archive/Delete 枚举，所以这里单独维护映射）
    "status_to_action": {
        "Core Infrastructure": "Keep",
        "Flagship Product": "Keep",
        "Historical / Superseded": "Archive",
        "Historical / Paused": "Archive",
        "Noise": "Delete",
    },
    # 留空即从 PATH 解析（launchd 的 PATH 极窄，install.sh 会显式注入）
    "lark_cli": "",
    "gh_cli": "",
}

ACTIVITY = {"active": "活跃", "cooling": "降温", "stale": "停滞", "dormant": "休眠"}
CHANGE = {"base": "基线", "new": "新增", "rename": "重命名",
          "archived": "归档", "same": "无变化", "gone": "已消失"}
ACTIVITY_OPTIONS = list(ACTIVITY.values())
CHANGE_OPTIONS = list(CHANGE.values())
VISIBILITY_OPTIONS = ["Public", "Private", "Internal"]
GOVERNANCE_OPTIONS = [
    "⭐ Core Infrastructure",
    "🟢 Flagship Product",
    "🟡 Historical / Superseded",
    "🔴 Noise",
]
ACTION_OPTIONS = ["Keep", "Archive", "Delete"]

NUM0 = {"type": "plain", "precision": 0}


REQUIRED_CONFIG_KEYS = ("github_login", "base_token", "registry_table")


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    missing = [k for k in REQUIRED_CONFIG_KEYS if not str(cfg.get(k) or "").strip()]
    if missing:
        raise ConfigError(
            f"缺少必填配置 {missing}。\n"
            f"  配置文件路径：{CONFIG_PATH}\n"
            f"  模板：同目录 config.example.json\n"
            f"  可用环境变量 GITHUB_SNAPSHOT_HOME 指到别的工作目录。"
        )
    return cfg


class ConfigError(RuntimeError):
    """配置缺失或不可用。独立于 SnapshotError，因为它在任何外部调用之前就会发生。"""


# --------------------------------------------------------------------------- #
# 子进程封装
# --------------------------------------------------------------------------- #

class SnapshotError(RuntimeError):
    pass


def _exec(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


_BIN_CACHE: dict[str, str] = {}


def bin_path(cfg_key: str, name: str) -> str:
    """优先用 config 里的绝对路径；不存在或不可执行时回退到 PATH 查找。"""
    if cfg_key in _BIN_CACHE:
        return _BIN_CACHE[cfg_key]
    configured = CFG.get(cfg_key) or ""
    resolved = configured if configured and os.access(configured, os.X_OK) else None
    if not resolved:
        resolved = shutil.which(name)
    if not resolved:
        raise SnapshotError(f"找不到可执行文件 {name}（config.{cfg_key} 和 PATH 都没有）")
    _BIN_CACHE[cfg_key] = resolved
    return resolved


def _extract_json(text: str) -> dict:
    """lark-cli 偶尔会在 stdout 前混入提示行，取第一个 '{' 开始解析。"""
    i = text.find("{")
    if i < 0:
        raise SnapshotError(f"未找到 JSON 输出：{text[:300]!r}")
    return json.loads(text[i:])


# --------------------------------------------------------------------------- #
# GitHub —— 客观事实层
# --------------------------------------------------------------------------- #

REPO_QUERY = """
query($cursor: String) {
  viewer {
    login
    createdAt
    repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER],
                 orderBy: {field: CREATED_AT, direction: ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        url
        createdAt
        pushedAt
        isPrivate
        isArchived
        isFork
        description
        homepageUrl
        repositoryTopics(first: 20) { nodes { topic { name } } }
        stargazerCount
        forkCount
        pullRequests { totalCount }
        releases { totalCount }
        defaultBranchRef { name target { ... on Commit { history { totalCount } } } }
      }
    }
  }
}
""".strip()


def gh_graphql(query: str, variables: dict) -> dict:
    cmd = [bin_path("gh_cli", "gh"), "api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if v is not None:
            cmd += ["-F", f"{k}={v}"]
    p = _exec(cmd)
    if p.returncode != 0:
        raise SnapshotError(
            f"gh api graphql 失败（exit {p.returncode}）：{p.stderr.strip()[:400]}\n"
            f"请确认 `gh auth status` 显示的账号与 config.github_login"
            f"（{CFG.get('github_login') or '未配置'}）一致。"
        )
    return json.loads(p.stdout)


def fetch_repos() -> tuple[list[dict], dict]:
    """拉取本人 owner 的全部仓库，带分页。返回 (nodes, meta)。"""
    nodes: list[dict] = []
    cursor = None
    meta: dict = {}
    while True:
        payload = gh_graphql(REPO_QUERY, {"cursor": cursor})
        viewer = payload["data"]["viewer"]
        meta = {"login": viewer["login"], "account_created_at": viewer["createdAt"]}
        repo_block = viewer["repositories"]
        nodes.extend(repo_block["nodes"])
        meta["total_count"] = repo_block["totalCount"]
        if repo_block["pageInfo"]["hasNextPage"]:
            cursor = repo_block["pageInfo"]["endCursor"]
        else:
            break

    for n in nodes:
        branch = n.get("defaultBranchRef")
        n["_commits"] = branch["target"]["history"]["totalCount"] if branch else 0
        n["_branch"] = branch["name"] if branch else ""
    return nodes, meta


def normalize_repo(node: dict, run_at: dt.datetime) -> dict:
    """把 GitHub node 规范化成快照事实。"""
    pushed = dt.datetime.fromisoformat(node["pushedAt"].replace("Z", "+00:00"))
    created = dt.datetime.fromisoformat(node["createdAt"].replace("Z", "+00:00"))
    days = (run_at - pushed).days

    buckets = CFG["activity_buckets"]
    if days <= buckets["active"]:
        state = ACTIVITY["active"]
    elif days <= buckets["cooling"]:
        state = ACTIVITY["cooling"]
    elif days <= buckets["stale"]:
        state = ACTIVITY["stale"]
    else:
        state = ACTIVITY["dormant"]

    if node["isPrivate"]:
        vis = "Private"
    else:
        vis = "Public"

    return {
        "repo_id": node["id"],
        "repo_name": node["name"],
        "url": node["url"],
        "visibility": vis,
        "archived": bool(node["isArchived"]),
        "is_fork": bool(node["isFork"]),
        "description": node.get("description") or "",
        "stars": node["stargazerCount"],
        "forks": node["forkCount"],
        "commits": node["_commits"],
        "pull_requests": node["pullRequests"]["totalCount"],
        "releases": node["releases"]["totalCount"],
        "default_branch": node["_branch"],
        "created_at": created,
        "pushed_at": pushed,
        "days_since_push": days,
        "activity_state": state,
        # ---- 可发现性：前三项直接来自 API ----
        "has_description": bool((node.get("description") or "").strip()),
        "topics_count": len(((node.get("repositoryTopics") or {}).get("nodes") or [])),
        "has_homepage": bool((node.get("homepageUrl") or "").strip()),
        # readme_early_install 需要额外调 REST，由 attach_readme_flags() 先填进 node
        "readme_early_install": node.get("_readme_early_install"),
    }


def check_readme_early_install(repo_name: str) -> bool | None:
    """README 前 10 个非空行内是否就出现代码块/安装命令。

    这是**逆向判据**：不去判断"第一屏写得好不好"（主观、机械规则不可靠），
    只判断是否踩了"还没说清是什么，就先甩安装命令"这个客观坏模式。
    返回 None 表示没有 README 或读取失败。
    """
    p = _exec([bin_path("gh_cli", "gh"), "api",
               f"repos/{CFG['github_login']}/{repo_name}/readme", "--jq", ".content"])
    if p.returncode != 0 or not p.stdout.strip():
        return None
    try:
        import base64
        txt = base64.b64decode(p.stdout.strip()).decode("utf-8", "ignore")
    except Exception:
        return None
    nonempty = [l.strip() for l in txt.split("\n") if l.strip()]
    for line in nonempty[:10]:
        if line.startswith("```"):
            return True
    return False


def attach_readme_flags(repos: list[dict]) -> None:
    """给每个仓库补上 readme_early_install。"""
    for node in repos:
        node["_readme_early_install"] = check_readme_early_install(node["name"])


# --------------------------------------------------------------------------- #
# 飞书 Base —— 读写
# --------------------------------------------------------------------------- #

def lark(args: list[str], *, expect_ok: bool = True) -> dict:
    p = _exec([bin_path("lark_cli", "lark-cli")] + args + ["--as", "user"])
    if p.returncode != 0:
        raise SnapshotError(f"lark-cli 退出码 {p.returncode}：{p.stderr.strip()[:400]}")
    out = _extract_json(p.stdout or "{}")
    if expect_ok and not out.get("ok"):
        err = out.get("error", {})
        raise SnapshotError(
            f"lark-cli 报错 [{err.get('type')}/{err.get('subtype')}] "
            f"{err.get('message')}\n提示：{err.get('hint', '')}"
        )
    return out.get("data", {})


def base_blocks() -> list[dict]:
    return lark(["base", "+base-block-list", "--base-token", CFG["base_token"],
                 "--format", "json"]).get("blocks", [])


def resolve_table(name: str) -> str | None:
    for b in base_blocks():
        if b.get("type") == "table" and b.get("name") == name:
            return b["id"]
    return None


def read_records(table_id: str, field_names: list[str] | None = None) -> list[dict]:
    """读取整表，按 200/页 翻页，返回 [{_record_id, 字段名: 值}]。"""
    rows: list[dict] = []
    offset = 0
    while True:
        args = ["base", "+record-list", "--base-token", CFG["base_token"],
                "--table-id", table_id, "--limit", "200", "--offset", str(offset),
                "--format", "json"]
        for f in (field_names or []):
            args += ["--field-id", f]
        data = lark(args)
        fields = data.get("fields", [])
        for rid, row in zip(data.get("record_id_list", []), data.get("data", [])):
            rec = {"_record_id": rid}
            for k, v in zip(fields, row):
                rec[k] = v
            rows.append(rec)
        if not data.get("has_more"):
            break
        offset += len(data.get("data", []))
    return rows


def batch_create(table_id: str, records: list[dict]) -> list[str]:
    created: list[str] = []
    for i in range(0, len(records), 200):
        chunk = records[i:i + 200]
        payload = json.dumps({"create_records": chunk}, ensure_ascii=False)
        data = lark(["base", "+record-batch-create", "--base-token", CFG["base_token"],
                     "--table-id", table_id, "--json", payload, "--format", "json"])
        created += data.get("record_id_list", [])
    return created


def delete_records(table_id: str, record_ids: list[str]) -> None:
    for i in range(0, len(record_ids), 200):
        chunk = record_ids[i:i + 200]
        args = ["base", "+record-delete", "--base-token", CFG["base_token"],
                "--table-id", table_id]
        for rid in chunk:
            args += ["--record-id", rid]
        lark(args + ["--yes", "--format", "json"])


# ---- 表结构 ---------------------------------------------------------------- #

def history_fields() -> list[dict]:
    return [
        {"type": "text", "name": "repo_name"},
        {"type": "text", "name": "repo_id", "description": "GitHub 稳定 node id，用于识别重命名"},
        {"type": "text", "name": "snapshot_period", "description": "YYYY-MM"},
        {"type": "datetime", "name": "snapshot_date", "style": {"format": "yyyy-MM-dd"}},
        {"type": "text", "name": "url", "style": {"type": "url"}},
        {"type": "select", "name": "visibility", "multiple": False,
         "options": [{"name": v} for v in VISIBILITY_OPTIONS]},
        {"type": "checkbox", "name": "archived"},
        {"type": "checkbox", "name": "is_fork"},
        {"type": "text", "name": "description"},
        {"type": "number", "name": "stars", "style": NUM0},
        {"type": "number", "name": "forks", "style": NUM0},
        {"type": "number", "name": "commits", "style": NUM0},
        {"type": "number", "name": "pull_requests", "style": NUM0},
        {"type": "number", "name": "releases", "style": NUM0},
        {"type": "text", "name": "default_branch"},
        {"type": "datetime", "name": "created_at", "style": {"format": "yyyy-MM-dd"}},
        {"type": "datetime", "name": "pushed_at", "style": {"format": "yyyy-MM-dd"}},
        {"type": "number", "name": "days_since_push", "style": NUM0},
        {"type": "select", "name": "activity_state", "multiple": False,
         "options": [{"name": v} for v in ACTIVITY_OPTIONS]},
        {"type": "select", "name": "change_type", "multiple": False,
         "options": [{"name": v} for v in CHANGE_OPTIONS]},
        {"type": "number", "name": "commits_delta", "style": NUM0},
        {"type": "number", "name": "pull_requests_delta", "style": NUM0},
        {"type": "number", "name": "releases_delta", "style": NUM0},
        {"type": "select", "name": "governance_status", "multiple": False,
         "options": [{"name": v} for v in GOVERNANCE_OPTIONS],
         "description": "来自 Repository Inventory -> Repository Registry（策展层，只读）"},
        {"type": "select", "name": "lifecycle_action", "multiple": False,
         "options": [{"name": v} for v in ACTION_OPTIONS]},
        {"type": "text", "name": "github_action",
         "description": "Registry 里对该分类的 GitHub 操作处方"},
        {"type": "text", "name": "reason",
         "description": "人工判断依据（脚本只沿用，不生成、不覆盖）"},
        {"type": "text", "name": "drift_alert", "description": "治理漂移告警，机器生成"},
    ]


def discoverability_fields() -> list[dict]:
    """可发现性字段：把"别人能不能找到你"变成可追踪的月度指标。

    全部是客观可机器判定的量，不需要人工输入：
    - has_description       GitHub 搜索结果里唯一显示的文字
    - topics_count          Topics 是硬筛选项（topic:xxx）
    - has_homepage          信任信号 + 更多信息的入口
    - readme_early_install  README 前 10 行内就出现安装命令（逆向判据，客观）
    - discoverability_score 0-4 派生分，便于排序/筛选出最该修的仓库
    """
    return [
        {"type": "checkbox", "name": "has_description",
         "description": "仓库 Description 是否已填（GitHub 搜索结果里唯一显示的文字）"},
        {"type": "number", "name": "topics_count", "style": NUM0,
         "description": "GitHub Topics 数量（topic: 硬筛选项）"},
        {"type": "checkbox", "name": "has_homepage",
         "description": "是否挂了站点 / 演示地址"},
        {"type": "checkbox", "name": "readme_early_install",
         "description": "README 前 10 行内就出现代码块/安装命令（踩雷，True=有问题）"},
        {"type": "number", "name": "discoverability_score", "style": NUM0,
         "description": "0-4 派生分：描述/主题/主页/首屏四项达标数，用来排序找出最该修的"},
    ]


def discoverability_score(f: dict) -> int:
    """0-4 派生分。readme_early_install 为 None 时该项不计分也不扣分。"""
    score = 0
    if f.get("has_description"):
        score += 1
    if (f.get("topics_count") or 0) > 0:
        score += 1
    if f.get("has_homepage"):
        score += 1
    if f.get("readme_early_install") is False:
        score += 1
    return score


def runs_fields() -> list[dict]:
    def n(name, desc=None):
        f = {"type": "number", "name": name, "style": NUM0}
        if desc:
            f["description"] = desc
        return f

    return [
        {"type": "text", "name": "run_label"},
        {"type": "text", "name": "snapshot_period"},
        {"type": "datetime", "name": "run_at", "style": {"format": "yyyy-MM-dd HH:mm"}},
        {"type": "text", "name": "trigger", "description": "manual / launchd"},
        {"type": "checkbox", "name": "dry_run"},
        n("repo_count"), n("new_count"), n("renamed_count"), n("archived_count"),
        n("removed_count"), n("active_count"), n("dormant_count"),
        n("stale_count", "超过 90 天未推送"),
        n("total_commits"), n("commits_delta_total"),
        n("governance_alert_count"),
        {"type": "text", "name": "report", "description": "本次运行的 Markdown 摘要"},
    ]


def table_field_map(table_id: str) -> dict[str, dict]:
    data = lark(["base", "+field-list", "--base-token", CFG["base_token"],
                 "--table-id", table_id, "--format", "json"])
    return {f["name"]: f for f in data.get("fields", [])}


def ensure_table(name: str, fields: list[dict], dry_run: bool) -> str:
    tid = resolve_table(name)
    if tid:
        # 补齐缺失字段（容忍后续版本新增列）
        existing = table_field_map(tid)
        missing = [f for f in fields if f["name"] not in existing]
        if missing and not dry_run:
            lark(["base", "+field-create", "--base-token", CFG["base_token"],
                  "--table-id", tid, "--json", json.dumps(missing, ensure_ascii=False),
                  "--format", "json"])
        elif missing:
            print(f"    [dry-run] 将为「{name}」补 {len(missing)} 个字段："
                  f"{[m['name'] for m in missing]}")
        return tid

    if dry_run:
        print(f"    [dry-run] 将创建表「{name}」（{len(fields)} 字段）")
        return f"dryrun-{name}"

    data = lark(["base", "+table-create", "--base-token", CFG["base_token"],
                 "--name", name, "--fields", json.dumps(fields, ensure_ascii=False),
                 "--format", "json"])
    tid = (data.get("table_id") or data.get("id")
           or (data.get("table") or {}).get("table_id"))
    if not tid:
        tid = resolve_table(name)
    if not tid:
        raise SnapshotError(f"创建表「{name}」后未能解析 table_id：{data}")
    return tid


# --------------------------------------------------------------------------- #
# 策展层 join
# --------------------------------------------------------------------------- #

def _as_list(v):
    if v is None:
        return []
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return [v]
    return v if isinstance(v, list) else [v]


def _scalar(v):
    """把从 Base 读回来的 select/多选值（list）归一成标量。

    快照写入时字段值是标量；但从上一期快照继承时读回来的是 list，
    不归一就会写出 [[值]] 这种嵌套结构，被 Base 当成非法值拒绝。
    """
    if isinstance(v, (list, tuple)):
        return v[0] if v else ""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return str(v)


def load_curated() -> tuple[dict[str, dict], set[str]]:
    """返回 (repo_name -> 治理信息, Inventory 里登记的名字集合)。

    策展表（Inventory / Registry）是可选输入：治理执行完毕后这两张表可能被清理。
    缺失时不报错 —— 治理字段会由 build_snapshot 从上一期快照沿用，
    所以分类不会因为删表而丢失。
    """
    curated: dict[str, dict] = {}
    names: set[str] = set()
    tid_inv = CFG.get("inventory_table")
    tid_reg = CFG.get("registry_table")
    if not tid_inv:
        return curated, names
    try:
        registry = {r["_record_id"]: r for r in read_records(tid_reg)} if tid_reg else {}
        rows = read_records(tid_inv)
    except SnapshotError as exc:
        if "not_found" in str(exc) or "800030104" in str(exc):
            print("        策展表已不存在，治理字段将从上一期快照沿用")
            return curated, names
        raise

    for row in rows:
        name = (row.get("Repository") or "").strip()
        if not name:
            continue
        names.add(name)
        links = _as_list(row.get("分类"))
        rid = links[0].get("id") if links and isinstance(links[0], dict) else None
        reg = registry.get(rid or "", {})
        status = EMOJI_RE.sub("", str(reg.get("Repository Status") or "")).strip()
        raw_status = str(reg.get("Repository Status") or "").strip()
        curated[name] = {
            # 存进快照的值保持原样（含 emoji），与 governance_status 的 select 选项一致；
            # 只用去掉 emoji 的版本做「分类 → 动作」映射
            "governance_status": raw_status,
            "github_action": str(reg.get("GitHub Action") or ""),
            "lifecycle_action": CFG["status_to_action"].get(status, ""),
            "reason": str(row.get("reason") or ""),
            "special": bool(row.get("特殊")),
        }
    return curated, names


def load_baseline(resolve_ids: dict[str, str] | None = None) -> dict[str, dict]:
    """可选的"治理基线"锚点表，按 repo_name 索引。

    这张表是历史存档，随时可能被清理 —— 所以它**不是必需品**：
    - 有它：首次运行时用它做差分锚点；
    - 没它：首次运行就没有锚点，之后的月份一律用「历史表上一期」做锚点。

    基线表里通常没有 repo_id，所以用当前 GitHub 仓库列表按名字回填一份，
    让基线锚点也能带着稳定 id 走（rename 检测依赖它）。
    """
    tid = CFG.get("baseline_table")
    if not tid:
        return {}
    try:
        rows = read_records(tid)
    except SnapshotError as exc:
        if "not_found" in str(exc) or "800030104" in str(exc):
            print(f"        基线表 {tid} 已不存在，跳过（改用历史表做差分锚点）")
            return {}
        raise

    resolve_ids = resolve_ids or {}
    base: dict[str, dict] = {}
    for row in rows:
        name = (row.get("repo_name") or "").strip()
        if not name:
            continue
        rs = _as_list(row.get("repository_status"))
        la = _as_list(row.get("lifecycle_action"))
        base[name] = {
            "repo_name": name,
            "repo_id": resolve_ids.get(name, ""),
            "created_at": row.get("created_at"),
            "pushed_at": row.get("pushed_at"),
            "commits": row.get("commits") or 0,
            "pull_requests": row.get("pull_requests") or 0,
            "releases": row.get("releases") or 0,
            "archived": bool(row.get("archived")),
            "governance_status": (rs[0] if rs else "") or "",
            "lifecycle_action": (la[0] if la else "") or "",
            "reason": row.get("reason") or "",
        }
    return base


def load_previous_period(history_table: str, period: str) -> dict[str, dict] | None:
    """取历史表里早于当前 period 的最近一次快照，按 repo_id / repo_name 索引。

    会跳过上一期里「已消失」的记录：消失这件事只在发生的那一期记一次，
    否则每期都会把同一批已消失的仓库再报一遍。
    """
    if history_table.startswith("dryrun-"):
        return None
    rows = read_records(history_table)
    if not rows:
        return None
    periods = sorted({r.get("snapshot_period") for r in rows if r.get("snapshot_period")})
    earlier = [p for p in periods if p < period]
    if not earlier:
        return None
    prev = earlier[-1]
    out: dict[str, dict] = {}
    for r in rows:
        if r.get("snapshot_period") != prev:
            continue
        if CHANGE["gone"] in _as_list(r.get("change_type")):
            continue
        key = r.get("repo_id") or r.get("repo_name")
        out[key] = r
    return out


# --------------------------------------------------------------------------- #
# 差分计算
# --------------------------------------------------------------------------- #

def _parse_dt(v):
    if not v:
        return None
    if isinstance(v, (int, float)):
        return dt.datetime.fromtimestamp(v / 1000, tz=dt.timezone.utc)
    s = str(v).replace("Z", "+00:00")
    try:
        return dt.datetime.fromisoformat(s)
    except ValueError:
        return None


def _created_key(v) -> str:
    d = _parse_dt(v)
    return d.strftime("%Y-%m-%d") if d else ""


def build_snapshot(repos: list[dict], run_at: dt.datetime, period: str,
                   curated: dict[str, dict], curated_names: set[str],
                   baseline: dict[str, dict], previous: dict[str, dict] | None
                   ) -> tuple[list[dict], dict]:
    """把事实 + 策展 + 上一期对出一条时间序列，并算出本期摘要。"""
    # 差分锚点：优先用历史表的上一期，其次用 2026-10-02 基线
    anchor_by_name: dict[str, dict] = {}
    anchor_by_id: dict[str, dict] = {}
    anchor_kind = "none"
    if previous:
        anchor_kind = "history"
        for k, r in previous.items():
            anchor_by_id[k] = r
            if r.get("repo_name"):
                anchor_by_name[r["repo_name"]] = r
    else:
        anchor_by_name = dict(baseline)
        anchor_kind = "baseline" if anchor_by_name else "none"

    anchor_by_created: dict[str, str] = {}
    for nm, r in anchor_by_name.items():
        ck = _created_key(r.get("created_at"))
        if ck:
            anchor_by_created.setdefault(ck, nm)

    matched_anchor: set[str] = set()
    facts: list[dict] = []
    renames: list[tuple[str, str]] = []

    for repo in repos:
        fact = normalize_repo(repo, run_at)
        name, rid = fact["repo_name"], fact["repo_id"]

        anchor = anchor_by_id.get(rid) or anchor_by_name.get(name)

        if anchor is None:
            # 名字和 id 都对不上 —— 尝试用 createdAt 认领一个未匹配的旧名字（重命名）
            ck = _created_key(repo["createdAt"])
            old_name = anchor_by_created.get(ck)
            if old_name and old_name not in matched_anchor:
                anchor = anchor_by_name[old_name]
                renames.append((old_name, name))

        if anchor is None:
            if anchor_kind == "none":
                # 完全没有锚点 = 这一期就是基线本身，不能算"新增"，
                # 否则首次快照会谎报"25 个新增仓库"、增量也全是满值
                change = CHANGE["base"]
                prev_commits = fact["commits"]
                prev_prs = fact["pull_requests"]
                prev_rel = fact["releases"]
            else:
                change = CHANGE["new"]
                prev_commits = prev_prs = prev_rel = 0
            was_archived = False
        else:
            anchor_name = anchor.get("repo_name") or name
            matched_anchor.add(anchor_name)
            matched_anchor.add(name)
            if anchor_name != name:
                if (anchor_name, name) not in renames:
                    renames.append((anchor_name, name))
                change = CHANGE["rename"]
            elif fact["archived"] and not anchor.get("archived"):
                change = CHANGE["archived"]
            else:
                change = CHANGE["same"]
            prev_commits = anchor.get("commits") or 0
            prev_prs = anchor.get("pull_requests") or 0
            prev_rel = anchor.get("releases") or 0
            was_archived = bool(anchor.get("archived"))

        fact["change_type"] = change
        fact["commits_delta"] = fact["commits"] - prev_commits
        fact["pull_requests_delta"] = fact["pull_requests"] - prev_prs
        fact["releases_delta"] = fact["releases"] - prev_rel
        fact["_was_archived"] = was_archived

        # 策展层 join（Inventory 优先，其次基线表里人工写过的判断）
        c = curated.get(name)
        if not c:
            for old_name, new_name in renames:
                if new_name == name and old_name in curated:
                    c = curated[old_name]
                    break
        if not c and anchor:
            c = {"governance_status": _scalar(anchor.get("governance_status")),
                 "lifecycle_action": _scalar(anchor.get("lifecycle_action")),
                 "github_action": _scalar(anchor.get("github_action")),
                 "reason": _scalar(anchor.get("reason")), "special": False}

        fact["governance_status"] = (c or {}).get("governance_status", "") or ""
        fact["lifecycle_action"] = (c or {}).get("lifecycle_action", "") or ""
        fact["github_action"] = (c or {}).get("github_action", "") or ""
        # reason 是人写的判断：优先策展层，其次从锚点沿用
        # （快照要保留"当时的判断"，所以人工字段只沿用、绝不生成）
        reason = (c or {}).get("reason", "") or ""
        if not reason and anchor:
            reason = _scalar(anchor.get("reason"))
        fact["reason"] = reason
        facts.append(fact)

    # 消失的仓库：上一期有、本期没有。
    # 它们**不落行** —— 快照的一行 = 那一刻真实存在的仓库。
    # "消失"这件事由三个地方承载：
    #   ① 本次运行的报告（下面 summary["disappeared"]）
    #   ② Snapshot Runs.removed_count 计数器
    #   ③ 跨期对比时自然浮现（A 有、B 没有）
    # 之前把它们写成 "已消失" 行是错的：会让"当前状态"里混进幽灵记录。
    disappeared: list[str] = []
    for nm in anchor_by_name:
        if nm not in matched_anchor:
            disappeared.append(nm)

    # ---- 治理漂移告警 ----
    buckets = CFG["activity_buckets"]
    alerts: list[dict] = []
    for f in facts:
        notes = []
        action = f.get("lifecycle_action") or ""
        days = f["days_since_push"]
        status = f.get("governance_status") or ""

        if not status:
            notes.append("未在 Repository Inventory 登记分类")
        if action == "Keep" and days > buckets["cooling"]:
            notes.append(f"标为 Keep 但已 {days} 天未推送")
        # 已归档的仓库动作已经完成 —— 它不可能再推送（pushedAt 冻结在归档那一刻），
        # 所以不再报"标为 Archive 但仍在推送"
        if not f["archived"] and action in ("Archive", "Delete") and days <= buckets["active"]:
            notes.append(f"标为 {action} 但 {days} 天内仍在推送（判断可能已过期）")
        if f["archived"] and action not in ("Archive", ""):
            notes.append(f"GitHub 上已归档，但治理动作是 {action}")
        if not f["archived"] and action == "Archive" and f.get("_was_archived"):
            pass
        f["drift_alert"] = "；".join(notes)
        if notes:
            alerts.append({"repo": f["repo_name"], "alert": f["drift_alert"]})

    # ---- 本期摘要 ----
    # facts 里的每一行都是本期真实存在的仓库（已消失的不落行），所以直接就是 live
    live = facts
    summary = {
        "period": period,
        "anchor_kind": anchor_kind,
        "repo_count": len(live),
        # ---- 可发现性体检：按分数升序，最该修的排最前 ----
        "discoverability": sorted(
            [{"repo": f["repo_name"], "score": discoverability_score(f),
              "has_description": bool(f.get("has_description")),
              "topics_count": f.get("topics_count") or 0,
              "has_homepage": bool(f.get("has_homepage")),
              "readme_early_install": f.get("readme_early_install")}
             for f in live],
            key=lambda x: (x["score"], x["repo"])),
        "new_count": sum(1 for f in live if f["change_type"] == "新增"),
        "renamed_count": len(renames),
        "archived_count": sum(1 for f in live if f["change_type"] == "归档"),
        "removed_count": len(disappeared),
        "active_count": sum(1 for f in live if f["activity_state"] == ACTIVITY["active"]),
        "dormant_count": sum(1 for f in live if f["activity_state"] == ACTIVITY["dormant"]),
        "stale_count": sum(1 for f in live if f["days_since_push"] > buckets["cooling"]),
        "total_commits": sum(f["commits"] for f in live),
        "commits_delta_total": sum(f["commits_delta"] for f in live),
        "pr_delta_total": sum(f["pull_requests_delta"] for f in live),
        "governance_alert_count": len(alerts),
        "renames": renames,
        "disappeared": disappeared,
        "alerts": alerts,
        "totals": {
            "commits": sum(f["commits"] for f in live),
            "pull_requests": sum(f["pull_requests"] for f in live),
            "releases": sum(f["releases"] for f in live),
        },
    }

    # 策展表本身过期（登记的名字已经不存在了）
    current_names = {f["repo_name"] for f in live}
    summary["curated_stale"] = sorted(n for n in curated_names if n not in current_names)
    return facts, summary


# --------------------------------------------------------------------------- #
# 报告
# --------------------------------------------------------------------------- #

def render_report(summary: dict, meta: dict, run_at: dt.datetime) -> str:
    L = []
    A = L.append
    p = summary["period"]
    A(f"# GitHub 资产快照 · {p}")
    A("")
    A(f"- 账号：`{meta.get('login')}`（注册于 {str(meta.get('account_created_at', ''))[:10]}）")
    A(f"- 运行时间：{run_at.strftime('%Y-%m-%d %H:%M %Z')}")
    anchor_label = {
        "history": "上一期历史快照",
        "baseline": "治理基线表",
    }.get(summary["anchor_kind"], "无（本期是首次快照）")
    A(f"- 差分锚点：{anchor_label}")
    A("")
    A("## 组合概览")
    A("")
    A("| 指标 | 数值 |")
    A("| --- | --- |")
    A(f"| 仓库总数 | {summary['repo_count']} |")
    A(f"| 本月新增 | {summary['new_count']} |")
    A(f"| 重命名 | {summary['renamed_count']} |")
    A(f"| 新归档 | {summary['archived_count']} |")
    A(f"| 已消失 | {summary['removed_count']} |")
    A(f"| 活跃（≤30 天） | {summary['active_count']} |")
    A(f"| 休眠（>180 天） | {summary['dormant_count']} |")
    A(f"| 超 90 天未推送 | {summary['stale_count']} |")
    A(f"| 累计 commits | {summary['totals']['commits']} |")
    A(f"| 本期 commits 增量 | +{summary['commits_delta_total']} |")
    A(f"| 治理漂移告警 | {summary['governance_alert_count']} |")
    A("")

    if summary["renames"]:
        A("## 重命名")
        A("")
        for old, new in summary["renames"]:
            A(f"- `{old}` → `{new}`（策展表需要同步更新）")
        A("")

    if summary["disappeared"]:
        A("## 已消失")
        A("")
        for n in summary["disappeared"]:
            A(f"- `{n}`")
        A("")

    if summary["curated_stale"]:
        A("## 策展表待更新")
        A("")
        A("Repository Inventory 里登记但这些仓库已不在账号中：")
        A("")
        for n in summary["curated_stale"]:
            A(f"- `{n}`")
        A("")

    # ---- 可发现性体检表 ----
    disc = summary.get("discoverability") or []
    if disc:
        n = len(disc)
        A("## 可发现性体检")
        A("")
        A(f"- 有描述：**{sum(1 for d in disc if d['has_description'])}/{n}**")
        A(f"- Topics 总数：**{sum(d['topics_count'] for d in disc)}**")
        A(f"- 有主页：**{sum(1 for d in disc if d['has_homepage'])}/{n}**")
        A(f"- README 首屏踩雷（前 10 行内就有安装命令）："
          f"**{sum(1 for d in disc if d['readme_early_install'] is True)}/{n}**")
        A(f"- 平均分：**{sum(d['score'] for d in disc)/n:.2f} / 4**")
        A("")
        A("| 仓库 | 分 | 描述 | Topics | 主页 | 首屏踩雷 |")
        A("| --- | --- | --- | --- | --- | --- |")
        for d in disc:
            A(f"| `{d['repo']}` | **{d['score']}** | "
              f"{'✅' if d['has_description'] else '❌'} | "
              f"{d['topics_count']} | "
              f"{'✅' if d['has_homepage'] else '❌'} | "
              f"{'⚠️ 是' if d['readme_early_install'] is True else ('否' if d['readme_early_install'] is False else '—')} |")
        A("")

    A("## 治理漂移告警")
    A("")
    if summary["alerts"]:
        for a in summary["alerts"][:40]:
            A(f"- **{a['repo']}**：{a['alert']}")
    else:
        A("- 无")
    A("")
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

def main() -> int:
    global CFG
    ap = argparse.ArgumentParser(description="GitHub 资产月度快照")
    ap.add_argument("--dry-run", action="store_true", help="只计算并打印，不写飞书")
    ap.add_argument("--no-base", action="store_true", help="不读也不写飞书，纯本地自检")
    ap.add_argument("--period", help="快照期间，默认当月（YYYY-MM）")
    ap.add_argument("--force", action="store_true", help="覆盖当月已有快照")
    ap.add_argument("--trigger", default="manual", help="触发来源：manual / launchd")
    ap.add_argument("--today", help="把'现在'覆盖成指定时间（调试用，ISO8601）")
    args = ap.parse_args()

    CFG = load_config()
    now = (dt.datetime.fromisoformat(args.today).replace(tzinfo=TZ)
           if args.today else dt.datetime.now(TZ))
    period = args.period or now.strftime("%Y-%m")
    write_base = not (args.dry_run or args.no_base)

    print(f"== GitHub 资产快照 · {period} ==")
    print(f"   时间：{now.strftime('%Y-%m-%d %H:%M %Z')}    模式："
          f"{'dry-run' if args.dry_run else ('no-base' if args.no_base else '写入飞书')}")

    # 1) 抓取事实
    print("  [1/5] 拉取 GitHub 仓库…")
    repos, meta = fetch_repos()
    print("  [1b/5] 检查各仓库 README 首屏…")
    attach_readme_flags(repos)
    print(f"        {meta['login']}：{len(repos)} 个仓库")

    # 2) 读策展层 + 基线
    curated: dict[str, dict] = {}
    curated_names: set[str] = set()
    baseline: dict[str, dict] = {}
    if not args.no_base:
        print("  [2/5] 读取策展层（Inventory / Registry）…")
        curated, curated_names = load_curated()
        baseline = load_baseline({n["name"]: n["id"] for n in repos})
        print(f"        Inventory {len(curated_names)} 条，基线 {len(baseline)} 条")
    else:
        print("  [2/5] 跳过策展层（--no-base）")

    # 3) 建表 / 定位历史表
    history_tid = runs_tid = ""
    if not args.no_base:
        print("  [3/5] 准备表结构…")
        history_tid = ensure_table(CFG["history_table_name"],
                                  history_fields() + discoverability_fields(), args.dry_run)
        runs_tid = ensure_table(CFG["runs_table_name"], runs_fields(), args.dry_run)

    # 幂等：同一 period 已有记录
    existing_runs = []
    if not args.no_base and runs_tid and not runs_tid.startswith("dryrun-"):
        existing_runs = [r for r in read_records(runs_tid)
                         if r.get("snapshot_period") == period]
    if existing_runs and args.dry_run:
        print(f"  （注意：期间 {period} 已有快照，正式写入会被幂等跳过；重跑需加 --force）")
    elif existing_runs and not args.force:
        print(f"  期间 {period} 已存在快照（run: {existing_runs[0]['_record_id']}）。"
              f"如需重跑请加 --force。")
        return 0

    previous = load_previous_period(history_tid, period) if history_tid else None
    if previous is None and baseline:
        print("        无上一期历史快照，改用 2026-10-02 治理基线做差分锚点")

    # 4) 计算
    print("  [4/5] 计算差分与治理告警…")
    facts, summary = build_snapshot(repos, now, period, curated, curated_names,
                                    baseline, previous)
    report = render_report(summary, meta, now)
    print(f"        仓库 {summary['repo_count']}，新增 {summary['new_count']}，"
          f"重命名 {summary['renamed_count']}，消失 {summary['removed_count']}，"
          f"告警 {summary['governance_alert_count']}")
    print()
    print(report)

    if args.dry_run or args.no_base:
        print("== dry-run/no-base：未写入飞书 ==")
        return 0

    # 5) 写入
    print("  [5/5] 写入飞书…")
    if existing_runs and args.force:
        old = [r["_record_id"] for r in read_records(history_tid)
               if r.get("snapshot_period") == period]
        if old:
            delete_records(history_tid, old)
            print(f"        已清除 {period} 旧记录 {len(old)} 条")
        delete_records(runs_tid, [r["_record_id"] for r in existing_runs])
        print(f"        已清除 {period} 旧运行记录 {len(existing_runs)} 条")

    stamp = now.replace(microsecond=0).isoformat()
    payload = []
    for f in facts:
        payload.append({
            "repo_name": f["repo_name"],
            "repo_id": f["repo_id"],
            "snapshot_period": period,
            "snapshot_date": stamp,
            "url": f["url"],
            "visibility": [f["visibility"]] if f["visibility"] else None,
            "archived": f["archived"],
            "is_fork": f["is_fork"],
            "description": f["description"],
            "stars": f["stars"],
            "forks": f["forks"],
            "commits": f["commits"],
            "pull_requests": f["pull_requests"],
            "releases": f["releases"],
            "default_branch": f["default_branch"],
            "created_at": f["created_at"].replace(microsecond=0).isoformat() if f["created_at"] else None,
            "pushed_at": f["pushed_at"].replace(microsecond=0).isoformat() if f["pushed_at"] else None,
            "days_since_push": f["days_since_push"],
            "activity_state": [f["activity_state"]] if f["activity_state"] else None,
            "change_type": [f["change_type"]],
            "commits_delta": f["commits_delta"],
            "pull_requests_delta": f["pull_requests_delta"],
            "releases_delta": f["releases_delta"],
            "governance_status": [f["governance_status"]] if f["governance_status"] else None,
            "lifecycle_action": [f["lifecycle_action"]] if f["lifecycle_action"] else None,
            "github_action": f["github_action"],
            "reason": f.get("reason", ""),
            "drift_alert": f["drift_alert"],
            "has_description": bool(f.get("has_description")),
            "topics_count": f.get("topics_count") or 0,
            "has_homepage": bool(f.get("has_homepage")),
            **({"readme_early_install": bool(f["readme_early_install"])}
               if f.get("readme_early_install") is not None else {}),
            "discoverability_score": discoverability_score(f),
        })
    ids = batch_create(history_tid, payload)
    print(f"        Repo Snapshot History：写入 {len(ids)} 行")

    run_rec = {
        "run_label": f"{period} GitHub 资产快照",
        "snapshot_period": period,
        "run_at": stamp,
        "trigger": args.trigger,
        "dry_run": False,
        "repo_count": summary["repo_count"],
        "new_count": summary["new_count"],
        "renamed_count": summary["renamed_count"],
        "archived_count": summary["archived_count"],
        "removed_count": summary["removed_count"],
        "active_count": summary["active_count"],
        "dormant_count": summary["dormant_count"],
        "stale_count": summary["stale_count"],
        "total_commits": summary["total_commits"],
        "commits_delta_total": summary["commits_delta_total"],
        "governance_alert_count": summary["governance_alert_count"],
        "report": report,
    }
    run_ids = batch_create(runs_tid, [run_rec])
    print(f"        Snapshot Runs：写入 {len(run_ids)} 行")
    print(f"== 完成：{period} 快照已落库 ==")
    return 0


# Module level stays tolerant: a missing config must still let `--help` and the
# test suite import this module. main() re-loads and reports the real error in
# a single, readable place.
try:
    CFG = load_config()
except ConfigError as _config_error:  # pragma: no cover - exercised via CLI
    CFG = {}
    _DEFERRED_CONFIG_ERROR = _config_error

if __name__ == "__main__":
    try:
        sys.exit(main())
    except ConfigError as e:
        print(f"\n[配置错误] {e}", file=sys.stderr)
        sys.exit(2)
    except SnapshotError as e:
        print(f"\n[错误] {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception:
        # 兜底：任何未预期异常都必须留下痕迹，不能静默退出
        import traceback
        print("\n[意外错误] 未处理的异常：", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)
