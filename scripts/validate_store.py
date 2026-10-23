#!/usr/bin/env python3
"""
Store Validator — deterministic structural checks
for the AI Capability Store.

Principle:
    LLM   does semantic judgment
    Script does deterministic protection
    Human does high-risk authorization

This validator NEVER:
    - judges whether a skill is good
    - decides whether an asset should be published
    - auto-promotes lifecycle
    - modifies files
    - publishes anything
    - deletes resources

Checks:
    1.  top-level registry parses (YAML, schema_version == 2, store identity)
    2.  router values: every route is present, is a non-empty string, and points to
        an existing file; domain registries are LOADED THROUGH the routed paths,
        so the top-level router is the true source of truth
    3.  domain registry headers (schema_version / domain / dependencies contract)
    4.  skill registry required fields (name/path/status/version/updated,
        + project for projects entries), map key == name, version X.Y.Z,
        updated YYYY-MM-DD, status legal
    5.  skill path validation: relative path, no ../ escape, directory, FLAT
        layout (exactly skills/<name>/), leaf == skill name, package contains
        SKILL.md and agents/openai.yaml
    5b. SKILL.md frontmatter validation against the external closed schema
        (only name/description/license/compatibility/metadata/allowed-tools;
        name == registry key; description non-empty) — the Store's proxy for
        the ecosystem gate, so a skill that cannot be installed cannot pass
    6.  registry <-> filesystem symmetry: a skill package directory on disk
        without a registry entry FAILS (and vice versa)
    6a-bis. no MISPLACED (nested) skill packages: a SKILL.md anywhere below
        skills/<name>/ FAILS. Discovery is non-recursive (correct, per Agent
        Plugins v1 §7.1), which used to mean such a package was silently
        ignored -- present on disk, uninstallable, and reported by nothing.
        This closes Issue #2 item 4.
    7.  duplicate skill identity across projects/shared FAILS
    8.  capability record required fields (name/provider/type/status/
        provider_path/hosting/version), type/status enums, map key == name,
        provider kebab-case, provider_path location and exists
    8b. hosting decides the shape: `store-managed` REQUIRES
        implementation_path (relative, under external-capabilities/, exists);
        `external` FORBIDS it and REQUIRES endpoint (https URL) +
        contract_path (exists). Neither may be inferred from a missing field.
    8c. service-call orchestrations: execution.requires (legal host abilities,
        must include network), execution.egress (domains), at least one step
        with `calls`, calls.service registered as an external capability,
        calls.contract exists and equals that capability's contract_path, and
        the service's endpoint host appears in egress.
    9.  provider identifiers and provider directory names are lowercase kebab-case
    10. dependency registry is parsed and its top-level contract validated
    11. dependency foreign keys: skill must exist in skills registry,
        capability must exist in external capabilities registry,
        required must be a boolean
    12. secret scan: only credential-bearing fields are flagged;
        reference-name metadata (e.g. secret_reference: production-github-token)
        is permitted and NOT flagged

NOTE on the secret scan: it is a LIGHTWEIGHT HEURISTIC, not a full repository
secret scanner. It guards registry files only. A stronger secret gate
(e.g. Gitleaks) should be evaluated separately if needed.

Usage:
    python3 scripts/validate_store.py
Exit code 0 = all checks pass; non-zero = failure.
"""

import datetime
import os
import posixpath
import re
import sys
from urllib.parse import urlparse

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.stderr.write("ERROR: PyYAML is required (pip install -r requirements-dev.txt)\n")
    sys.exit(2)


# ---- Duplicate-key-detecting YAML loader ----
# yaml.safe_load silently keeps the LAST occurrence of a duplicate mapping key,
# hiding ambiguous or overwritten source-of-truth declarations. This loader
# raises on any duplicate key so validation fails loudly instead.
class UniqueKeyLoader(yaml.SafeLoader):
    pass


def _construct_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping", node.start_mark,
                f"found duplicate key {key!r}", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STORE_NAME = "ai-capability-store"
STORE_OWNER = "LyraWang6688"
STORE_SCHEMA_VERSION = 2

ALLOWED_SKILL_STATUSES = {"draft", "testing", "active", "deprecated", "archived"}
# Placement classification lives on the record, not in the directory layout —
# the on-disk layout is flat (`skills/<name>/`) because Agent Plugins v1 requires
# `skills/` immediate children and forbids recursive discovery.
ALLOWED_SKILL_SCOPES = {"shared", "project"}
# The Agent Skills specification defines a CLOSED frontmatter schema: exactly
# these six top-level fields. The reference validator (`skills-ref`) rejects a
# skill outright for any extra field -- so a skill that adds e.g. `version`
# would pass every Store check and then silently fail to install. Enforcing the
# same whitelist here closes that gap. See SKILL-FORMAT.md §2.
ALLOWED_SKILL_FRONTMATTER = {
    "name", "description", "license", "compatibility", "metadata", "allowed-tools",
}
ALLOWED_CAPABILITY_TYPES = {"plugin", "mcp", "connector", "cli", "external-api", "integration"}
# `archived` is the retirement state: permanently out of service, kept so its
# history stays answerable. It is NOT `disabled` written twice — `disabled`
# means "not right now", `archived` means "not any more". Before this, a
# capability could be switched off but never retired, while a Skill or an
# Automation had a full lifecycle. See external-capabilities/README.md.
ALLOWED_CAPABILITY_STATUSES = {"available", "limited", "disabled", "unknown", "archived"}
# 托管方式（hosting）。这是 2026-10 放开的一条 policy：以前只收 Store-managed
# （代码必须在 external-capabilities/ 下），于是一个"后端在独立项目、店里只有 skill
# 和接口契约"的资产只能把服务写成自由文本，店里没有任何机器可查的事实。
#
#   store-managed —— 代码在店里；implementation_path 必填且必须存在
#   external      —— 代码在店外（自建后端）；店内只登记端点 + 契约，禁止写
#                    implementation_path（否则就是"登记了但店里没有代码"的假象，
#                    这正是旧 policy 想防的）
#
# 为什么不是"缺 implementation_path 就是 external"：缺字段是笔误，不是声明。
# 必须显式写 hosting，缺了就是错误。
ALLOWED_CAPABILITY_HOSTING = {"store-managed", "external"}
# Automation Domain. An automation is EXECUTION (a clock triggers it); a Skill is
# a CAPABILITY (an Agent decides to use it). The lifecycle vocabulary mirrors
# skills on purpose so one mental model covers both domains.
ALLOWED_AUTOMATION_STATUSES = {"draft", "testing", "active", "deprecated", "archived"}
# Classification ONLY. The authoritative cron lives in the bound workflow file;
# duplicating it here would create a second source of truth that silently drifts
# from what GitHub actually schedules. See automations/README.md.
# `monthly` exists because a monthly cadence is a real clock, not a degenerate
# daily: nothing schedules it from a workflow for us, and its catch-up behaviour
# (launchd fires on wake) differs from a daily job's.
# `quarterly` exists because "every 3 months" is a real cadence and every other value
# would be a lie for it: `monthly` fires 4x/year, `manual` says a human starts it.
# The list deliberately STOPS here. `yearly` is the obvious next instance of the same
# gap, but it has no consumer yet, and a speculative enum value is a guess dressed as
# a contract. Adding it later costs exactly the same six-file edit.
ALLOWED_TRIGGER_KINDS = {"daily", "weekly", "monthly", "quarterly", "manual", "event"}
# WHO runs it. The Automation Domain originally assumed GitHub Actions only, so
# `workflow` was unconditionally required; that made a launchd-driven job
# unrepresentable. Executor is a separate axis from trigger_kind:
#   trigger_kind = how often      executor = what runs it
ALLOWED_EXECUTORS = {"github-actions", "launchd", "systemd", "human"}
# WHERE the output lands. A `git-branch` target writes machine output to a branch
# that never merges (the data branch); an `external-system` target writes into
# something we do not own (e.g. a Feishu Base) and cannot be validated here.
# `local-file` exists because not every artifact wants to leave the machine it was
# produced on. A monthly server audit writes an HTML report for a human to open; its
# natural home is the server, and its content (hostnames, deploy paths, certificate
# expiry) is exactly what should NOT be committed to a branch. The validator cannot
# see the target filesystem, so it requires the declaration to be *specific* instead:
# where, how long it is kept, and how a human gets to it.
ALLOWED_OUTPUT_TARGETS = {"git-branch", "external-system", "local-file"}
# Automation output is high-frequency machine data; committing it to main would
# bury the Store's asset history (one year of daily snapshots ~= 365 commits).
AUTOMATION_OUTPUT_BRANCH = "data"
AUTOMATION_WORKFLOW_PREFIX = ".github/workflows/"
AUTOMATION_DIR = "automations"
# Directory names that are never assets. Used when a family container is
# inspected: a family holds files plus registered members, and it must not
# start failing because Python dropped a __pycache__ next to a shared module.
NON_ASSET_DIR_NAMES = {"__pycache__", "node_modules", "dist", ".venv", ".git"}

# Capability implementations live under shelves. These two hold documents, not
# capabilities, and are reserved on purpose. Every other shelf is CLOSED: each
# of its child directories must be some entry's `implementation_path`.
RESERVED_CAPABILITY_DIRS = {"providers", "use-cases"}
CAPABILITY_SHELVES = {"mcp", "connectors", "cli", "api", "plugin"}

# 生态层：货架下的【可选】一层，按"这个资产属于哪个生态"分组。
# 名字是封闭集合，理由和 CAPABILITY_SHELVES 一样 —— 新增一个生态是一次分类决策，
# 不该由某人随手建个目录来引入。
#
# 为什么是可选而不是必选：现在只有 plugin/ 下的三个 DSH 插件需要分组，
# 其它货架暂时平的。强制所有货架都加一层会让 8 个不需要分类的资产凭空多一级。
CAPABILITY_ECOSYSTEMS = {"dsh"}

# ---- Orchestration Domain ----
ORCHESTRATION_DIR = "orchestrations"
ALLOWED_ORCHESTRATION_STATUSES = {"testing", "available", "deprecated"}

# 布局是三层：<模式>/<目标>/<任务>/
#
# 模式回答"这一类任务靠什么跑完"—— 不是具体任务，也不是运行环境：
#   人说的那一句（manual）· 一个钟（scheduled-task）· 一个自建的后端服务（service-call）
#
# 前两个模式同时回答了"谁发起"；service-call 不回答 —— 它可以是人问的，也可以是
# 宿主定时任务叫醒的，所以 service-call 条目必须另写 trigger 字段（见下）。
# 这条轴被服务调用打破过一次，记在这里，免得下一个人再问"为什么不加第四个"。
#
# 三个都是封闭集合，理由和货架、生态一样：加一个是一次分类决策，
# 不该由某人随手建个目录来引入。
ORCHESTRATION_MODES = {"manual", "scheduled-task", "service-call"}

# 谁发起。只对 service-call 必填 —— 另外两个模式的名字已经说了。
# host-schedule = 宿主自带的定时任务（豆包/Codex 的 schedule），不是 store 里的 automation。
ALLOWED_ORCHESTRATION_TRIGGERS = {"human", "host-schedule", "daily", "weekly", "monthly", "event"}

# 宿主要具备什么才能跑这条编排。这是一份【能力清单】，不是软件清单：
#   bash / curl / network  —— 宿主的通用执行能力；服务调用的前提
#   feishu-native          —— 宿主自带飞书能力
#   lark-cli               —— 本机装了已登录的 lark-cli
#   python3 / browser      —— 宿主能跑脚本 / 能读网页
ALLOWED_HOST_REQUIREMENTS = {"bash", "curl", "network", "feishu-native", "lark-cli",
                             "python3", "browser"}

# 出网目的地：SOP 里显式指定的域名（契约端点 + 显式 curl）。
# 不是"这件事碰到的所有系统"——宿主自带能力把数据送到飞书，那不是这里记的。
EGRESS_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

# 第二级是【生态】—— 这个编排动用了哪个平台的资产。不是"谁执行"：
# 谁执行已经在 automations/registry.yaml 的 executor 字段里记过一次了，
# 再记一遍就是两个真相。
ORCHESTRATION_ECOSYSTEMS = {"dsh", "doubao-work", "wechat"}

KEBAB_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Leading YAML frontmatter block: --- ... --- at the very start of SKILL.md.
FRONTMATTER_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)

REQUIRED_POLICY_FILES = [
    "AGENTS.md",
    "CONTRIBUTING_AI.md",
    "PUBLISHING.md",
    "VERSIONING.md",
    "SKILL-FORMAT.md",
    "registry.yaml",
    "skills/README.md",
    "skills/registry.yaml",
    "orchestrations/README.md",
    "orchestrations/registry.yaml",
    "skills/LIFECYCLE.md",
    "skills/ACCEPTANCE.md",
    "external-capabilities/README.md",
    "external-capabilities/registry.yaml",
    "external-capabilities/SECURITY.md",
    "dependencies/capability-map.yaml",
    "automations/README.md",
    "automations/registry.yaml",
    "automations/LIFECYCLE.md",
    "tests/README.md",
    "templates/skill-eval-case.yaml",
    "templates/skill-acceptance-report.md",
    "requirements-dev.txt",
    ".github/workflows/validate-store.yml",
    "scripts/validate_store.py",
]

# Credential-bearing key names (the VALUE would be the secret material).
# Includes the bare `token` key: a standalone token field is credential-bearing.
SECRET_KEY_RE = re.compile(
    r"(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|secret|password|credential|cookie|auth[_-]?token|refresh[_-]?token|token)"
)
# Heuristic: an actual-looking secret value (>= 12 chars, not a placeholder).
SECRET_VALUE_RE = re.compile(r"^[A-Za-z0-9_\-./+]{12,}$")
PLACEHOLDER_VALUES = {"null", "none", "true", "false", "example", "xxx", "placeholder", "n/a", "na", "empty"}

checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))


def load_yaml(rel_path: str):
    """Load YAML. FAILS on missing, unparseable, or EMPTY documents.
    Returns (data, ok); data is None when not ok."""
    path = os.path.join(ROOT, rel_path)
    if not os.path.exists(path):
        check(f"exists: {rel_path}", False, "file not found")
        return None, False
    try:
        with open(path, encoding="utf-8") as fh:
            data = yaml.load(fh, Loader=UniqueKeyLoader)
    except Exception as exc:  # noqa: BLE001 (includes duplicate-key ConstructorError)
        check(f"parse: {rel_path}", False, str(exc))
        return None, False
    if data is None:
        check(f"non-empty registry: {rel_path}", False,
              "document is empty (yaml.safe_load returned None)")
        return None, False
    return data, True


def check_mapping(data, what):
    """Registry root documents must be mappings.

    A syntactically valid YAML document whose root is not a mapping (e.g. a
    list, or a scalar) must yield a deterministic FAIL — never an
    AttributeError/TypeError. Returns data when it is a dict, otherwise
    records the FAIL and returns None; callers must only .get() when a dict.
    """
    if not isinstance(data, dict):
        check(f"{what} is a mapping", False, type(data).__name__)
        return None
    return data


def validate_and_resolve_route(domain, raw_value):
    """Route Safety Validation -> validated relative repo path or None.

    A route may enter load_yaml() / scan_for_secrets() ONLY after passing
    every check here. On any failure the route FAIL is recorded and None is
    returned; the caller must NOT read, load or scan the target file.

    Guards: non-empty string, no '..' traversal, relative (no absolute path),
    realpath resolves inside the repository root (also defeats symlink
    escapes), and the target file exists.
    """
    if raw_value is None:
        check(f"route value present: {domain}", False, "missing route value")
        return None
    if not isinstance(raw_value, str) or len(raw_value) == 0:
        check(f"route value is non-empty string: {domain}", False, repr(raw_value))
        return None
    parts = raw_value.split("/")
    has_dotdot = ".." in parts
    is_abs = os.path.isabs(raw_value)
    check(f"route value has no '..': {domain}", not has_dotdot, raw_value)
    check(f"route value is a relative path: {domain}", not is_abs, raw_value)
    if has_dotdot or is_abs:
        return None
    rel = posixpath.normpath(raw_value)
    resolved = os.path.realpath(os.path.join(ROOT, rel))
    root_real = os.path.realpath(ROOT)
    inside = resolved == root_real or resolved.startswith(root_real + os.sep)
    check(f"route resolves inside repository: {domain}", inside, raw_value)
    if not inside:
        return None
    check(f"referenced registry exists: {rel}", os.path.exists(resolved), "file not found")
    if not os.path.exists(resolved):
        return None
    return rel


def scan_for_secrets(rel_path: str) -> None:
    """Lightweight heuristic secret scan on registry/data files.

    Reference-name metadata fields (e.g. secret_reference: production-github-token)
    are permitted authentication metadata and are NOT flagged. Only
    credential-bearing key: value pairs with real-looking values are flagged.
    This is a heuristic, NOT a full repository secret scanner."""
    if not rel_path.endswith((".yaml", ".yml", ".json")):
        return
    path = os.path.join(ROOT, rel_path)
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    hits = []
    for lineno, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_\-]+)\s*[:=]\s*[\"']?([^\"'\s,}]+)", stripped)
        if not m:
            continue
        key, value = m.group(1), m.group(2)
        k = key.lower()
        # Permitted authentication metadata: reference-name fields, never flagged.
        if k.endswith("_reference") or k.endswith("_ref") or k in ("reference", "ref"):
            continue
        if SECRET_KEY_RE.search(k) and SECRET_VALUE_RE.match(value):
            if value.lower() not in PLACEHOLDER_VALUES:
                hits.append(f"{rel_path}:{lineno} ({key})")
    check(f"secret scan: {rel_path}", not hits, "; ".join(hits) if hits else "clean")


def validate_skill_entries(reg: dict):
    """Validate the required-field schema of every skill record.

    One flat `skills:` mapping. Placement is no longer encoded by a registry
    section (`shared` / `projects`); it is a record field (`scope` / `project`),
    because the directory layout is flat and the registry is the single source
    of truth for classification.

    Returns list of (key, entry)."""
    entries_section = reg.get("skills")
    if entries_section is None:
        check("skill registry has skills section", False, "missing section")
        return []
    if not isinstance(entries_section, dict):
        check("skill registry skills is a mapping", False, type(entries_section).__name__)
        return []
    collected = []
    for key, entry in entries_section.items():
        if not isinstance(entry, dict):
            check(f"skill record is a mapping: {key}", False, type(entry).__name__)
            continue
        collected.append((key, entry))
        for field in ("name", "path", "status", "version", "updated"):
            val = entry.get(field)
            present = val is not None
            check(f"skill {key} has required field: {field}", present,
                  f"value={val!r}")
            if present:
                # Required field = presence + type + semantic format.
                # `updated` is a date-typed field: bare YAML dates (2026-10-01)
                # parse as datetime.date; quoted strings are equally valid.
                if field == "updated":
                    ok_type = isinstance(val, str) or isinstance(val, datetime.date)
                else:
                    ok_type = isinstance(val, str)
                check(f"skill {key} required field is non-empty string: {field}",
                      ok_type and (isinstance(val, datetime.date) or len(val) > 0),
                      f"value={val!r} type={type(val).__name__}")
        check(f"skill {key} map key == name", key == entry.get("name"),
              f"key={key!r} name={entry.get('name')!r}")
        check(f"skill {key} identifier kebab-case", bool(KEBAB_RE.match(key)),
              f"key={key!r}")
        name = entry.get("name")
        if isinstance(name, str) and name:
            check(f"skill {key} name kebab-case", bool(KEBAB_RE.match(name)), name)
        # Closed field set: classification is a record field, not a section.
        unknown = set(entry.keys()) - {
            "name", "path", "scope", "project", "status", "version", "updated", "notes",
        }
        check(f"skill {key} has only allowed fields", not unknown,
              f"unknown fields: {sorted(unknown)}")
        scope = entry.get("scope")
        if scope is not None:
            check(f"skill {key} scope legal", scope in ALLOWED_SKILL_SCOPES,
                  f"scope={scope!r} (allowed: {sorted(ALLOWED_SKILL_SCOPES)})")
        project = entry.get("project")
        if isinstance(project, str) and project:
            check(f"skill {key} project kebab-case", bool(KEBAB_RE.match(project)), project)
            # `project` describes a project-scoped skill; carrying it without
            # scope: project would recreate the second source of truth.
            check(f"skill {key} project requires scope: project",
                  scope == "project", f"scope={scope!r} project={project!r}")
        if scope == "project":
            check(f"skill {key} scope project requires project field",
                  isinstance(project, str) and bool(project), f"project={project!r}")
        status = entry.get("status")
        if status is not None:
            check(f"skill {key} status legal", status in ALLOWED_SKILL_STATUSES,
                  f"status={status!r}")
        version = entry.get("version")
        if isinstance(version, str):
            check(f"skill {key} version X.Y.Z", bool(VERSION_RE.match(version)), version)
            if VERSION_RE.match(version):
                # VERSIONING.md: 0.x is experimental/draft/testing, 1.x+ is
                # required for active; an experimental version must not be
                # marked active.
                major = int(version.split(".")[0])
                check(f"skill {key} active requires major >= 1",
                      status != "active" or major >= 1,
                      f"status={status!r} version={version}")
        updated = entry.get("updated")
        if isinstance(updated, str):
            shape_ok = bool(DATE_RE.match(updated))
            check(f"skill {key} updated YYYY-MM-DD", shape_ok, updated)
            if shape_ok:
                try:
                    datetime.date.fromisoformat(updated)
                    real_ok = True
                except ValueError:
                    real_ok = False
                check(f"skill {key} updated is a real calendar date", real_ok, updated)
        elif isinstance(updated, datetime.date):
            check(f"skill {key} updated YYYY-MM-DD",
                  bool(DATE_RE.match(updated.isoformat())), updated.isoformat())
    return collected


def validate_skill_path(key: str, entry: dict) -> None:
    """Path must be a flat, relative, contained directory with required files.

    Flat layout only: `skills/<skill-name>/` (exactly 2 components).

    Why flat is enforced here: Agent Plugins v1 §7.1 fixes skill discovery at
    `skills/` and requires each *immediate child directory* containing SKILL.md
    to be one skill, and states clients MUST NOT recurse into deeper
    descendants. A nested layout such as `skills/shared/<name>/` would therefore
    be invisible to conformant clients, so the validator refuses it rather than
    letting a skill pass Store validation and silently fail to install."""
    path = entry.get("path")
    if not isinstance(path, str) or not path:
        return
    check(f"skill {key} path is relative", not os.path.isabs(path), path)
    parts = path.split("/")
    check(f"skill {key} path has no '..'", ".." not in parts, path)
    abs_path = os.path.join(ROOT, path)
    check(f"skill {key} path is a directory", os.path.isdir(abs_path), path)
    leaf = path.rstrip("/").split("/")[-1]
    check(f"skill {key} path leaf == skill name", leaf == key, f"leaf={leaf!r} key={key!r}")
    # Exact flat layout: skills/<skill-name>/ — no category level, no nesting.
    check(f"skill {key} path is exactly skills/<name> (flat layout)",
          len(parts) == 2 and parts[0] == "skills", path)
    if os.path.isdir(abs_path):
        check(f"skill {key} package has SKILL.md",
              os.path.isfile(os.path.join(abs_path, "SKILL.md")), path)
        check(f"skill {key} package has agents/openai.yaml",
              os.path.isfile(os.path.join(abs_path, "agents", "openai.yaml")), path)


def validate_skill_frontmatter(key: str, skill_dir: str) -> None:
    """Validate SKILL.md frontmatter against the external closed schema.

    This is the Store's proxy for the ecosystem gate. Without it the Store could
    report "all checks pass" for a skill that `skills-ref validate` rejects --
    i.e. certify an asset that cannot be installed. See SKILL-FORMAT.md §2."""
    label = f"skill {key} frontmatter"
    path = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(path):
        return
    try:
        with open(path, encoding="utf-8") as fh:
            head = fh.read(16384)
    except OSError as exc:
        check(f"{label} readable", False, str(exc)[:80])
        return
    match = FRONTMATTER_RE.match(head)
    check(f"{label} block present", bool(match),
          "SKILL.md must begin with a --- YAML frontmatter block")
    if not match:
        return
    try:
        fm = yaml.load(match.group(1), Loader=UniqueKeyLoader)
    except Exception as exc:  # noqa: BLE001 (includes duplicate-key error)
        check(f"{label} parses", False, str(exc)[:120])
        return
    if not isinstance(fm, dict):
        check(f"{label} is a mapping", False, type(fm).__name__)
        return

    extra = sorted(set(fm.keys()) - ALLOWED_SKILL_FRONTMATTER)
    check(f"{label} uses only allowed fields", not extra,
          f"not allowed by the Agent Skills spec: {extra}; "
          f"allowed: {sorted(ALLOWED_SKILL_FRONTMATTER)}")

    name = fm.get("name")
    check(f"{label} name present", isinstance(name, str) and bool(name), repr(name))
    if isinstance(name, str):
        check(f"{label} name == registry key", name == key, f"name={name!r} key={key!r}")
        check(f"{label} name kebab-case", bool(KEBAB_RE.match(name)), name)
        check(f"{label} name length <= 64", len(name) <= 64, f"{len(name)} chars")

    desc = fm.get("description")
    check(f"{label} description present",
          isinstance(desc, str) and bool(desc.strip()), repr(desc)[:60])
    if isinstance(desc, str):
        check(f"{label} description length 1-1024", 1 <= len(desc) <= 1024,
              f"{len(desc)} chars")

    compat = fm.get("compatibility")
    if compat is not None:
        check(f"{label} compatibility is a string", isinstance(compat, str),
              type(compat).__name__)
        if isinstance(compat, str):
            check(f"{label} compatibility length 1-500", 1 <= len(compat) <= 500,
                  f"{len(compat)} chars")

    meta = fm.get("metadata")
    if meta is not None:
        ok_meta = isinstance(meta, dict) and all(
            isinstance(k, str) and isinstance(v, str) for k, v in meta.items())
        check(f"{label} metadata is a string -> string map", ok_meta, repr(meta)[:80])

    # The last two whitelisted fields were accepted without their shape being
    # checked: the whitelist said "you may write `allowed-tools`", not "write it
    # the way the spec defines it". A YAML list where a space-separated string is
    # required passes the whitelist and then breaks in the client — the same
    # failure shape as a required field that is only *present*.
    lic = fm.get("license")
    if lic is not None:
        check(f"{label} license is a non-empty string",
              isinstance(lic, str) and bool(lic.strip()), repr(lic)[:60])

    tools = fm.get("allowed-tools")
    if tools is not None:
        # Spec: "Space-separated string of pre-approved tools." A block scalar
        # (`|`) or a flow list both look reasonable in YAML and are both wrong.
        ok_tools = (
            isinstance(tools, str)
            and bool(tools.strip())
            and tools == tools.strip()
            and "\n" not in tools
        )
        check(f"{label} allowed-tools is a space-separated string", ok_tools,
              repr(tools)[:60])


def validate_capability_entries(reg: dict):
    """Validate capability record schema. Returns list of (key, entry)."""
    caps = reg.get("capabilities")
    if caps is None:
        check("capability registry has capabilities section", False, "missing section")
        return []
    if not isinstance(caps, dict):
        check("capability registry capabilities is a mapping", False, type(caps).__name__)
        return []
    collected = []
    for key, entry in caps.items():
        if not isinstance(entry, dict):
            check(f"capability record is a mapping: {key}", False, type(entry).__name__)
            continue
        collected.append((key, entry))
        # Required fields. `hosting` decides which of the two shapes applies:
        #   store-managed -> implementation_path is REQUIRED and must exist
        #   external      -> endpoint + contract_path are REQUIRED, and
        #                    implementation_path is FORBIDDEN
        # Before `hosting` existed, implementation_path was unconditionally
        # required because the Store accepted Store-managed capabilities only.
        # That made "backend in a separate project, only the skill and its
        # contract in the Store" unrepresentable — the service lived as free
        # text inside SKILL.md and no registry knew it existed.
        for field in ("name", "provider", "type", "status", "provider_path",
                      "hosting", "version"):
            val = entry.get(field)
            present = val is not None
            check(f"capability {key} has required field: {field}", present,
                  f"value={val!r}")
            if present:
                # Required field = presence + type + semantic format.
                check(f"capability {key} required field is non-empty string: {field}",
                      isinstance(val, str) and len(val) > 0,
                      f"value={val!r} type={type(val).__name__}")
        check(f"capability {key} map key == name", key == entry.get("name"),
              f"key={key!r} name={entry.get('name')!r}")
        check(f"capability {key} identifier kebab-case", bool(KEBAB_RE.match(key)),
              f"key={key!r}")
        ctype = entry.get("type")
        if ctype is not None:
            check(f"capability {key} type legal", ctype in ALLOWED_CAPABILITY_TYPES, f"type={ctype!r}")
        status = entry.get("status")
        if status is not None:
            check(f"capability {key} status legal", status in ALLOWED_CAPABILITY_STATUSES,
                  f"status={status!r}")
        provider = entry.get("provider")
        if isinstance(provider, str) and provider:
            check(f"capability {key} provider kebab-case", bool(KEBAB_RE.match(provider)), provider)
        pp = entry.get("provider_path")
        if isinstance(pp, str) and pp:
            parts = pp.split("/")
            check(f"capability {key} provider_path relative",
                  not os.path.isabs(pp) and ".." not in parts, pp)
            expected = f"external-capabilities/providers/{provider}/README.md" if isinstance(provider, str) else None
            if expected:
                check(f"capability {key} provider_path location", pp == expected,
                      f"{pp!r} (expected {expected!r})")
            check(f"capability {key} provider_path exists",
                  os.path.isfile(os.path.join(ROOT, pp)), pp)
        # Optional semantic version (Store-recommended version, see VERSIONING.md).
        version = entry.get("version")
        if version is not None:
            check(f"capability {key} version X.Y.Z",
                  isinstance(version, str) and bool(VERSION_RE.match(version)),
                  f"version={version!r} type={type(version).__name__}")
        hosting = entry.get("hosting")
        if isinstance(hosting, str) and hosting:
            check(f"capability {key} hosting legal", hosting in ALLOWED_CAPABILITY_HOSTING,
                  f"hosting={hosting!r} (expected one of {sorted(ALLOWED_CAPABILITY_HOSTING)})")
            impl = entry.get("implementation_path")
            if hosting == "store-managed":
                check(f"capability {key} store-managed declares implementation_path",
                      isinstance(impl, str) and bool(impl), f"implementation_path={impl!r}")
                # The path must be relative, live under external-capabilities/,
                # and actually exist. This whole block used to be guarded by
                # `if impl is not None`, so omitting the field silently skipped
                # every line of it.
                if isinstance(impl, str) and impl:
                    iparts = impl.split("/")
                    check(f"capability {key} implementation_path relative",
                          not os.path.isabs(impl) and ".." not in iparts, impl)
                    check(f"capability {key} implementation_path under external-capabilities/",
                          impl.startswith("external-capabilities/"), impl)
                    check(f"capability {key} implementation_path exists",
                          os.path.isdir(os.path.join(ROOT, impl)), impl)
            elif hosting == "external":
                # 店外服务：店里登记的是端点与契约，不是代码。写了
                # implementation_path 就是在说"我店里有这份代码"，与 hosting
                # 自相矛盾 —— 这正是旧 policy 想防的假象。
                check(f"capability {key} external does not declare implementation_path",
                      not (isinstance(impl, str) and impl), f"implementation_path={impl!r}")
                endpoint = entry.get("endpoint")
                check(f"capability {key} external declares endpoint",
                      isinstance(endpoint, str) and bool(endpoint), f"endpoint={endpoint!r}")
                if isinstance(endpoint, str) and endpoint:
                    parsed = urlparse(endpoint)
                    check(f"capability {key} endpoint is https URL",
                          parsed.scheme == "https" and bool(parsed.netloc),
                          f"endpoint={endpoint!r}")
                contract = entry.get("contract_path")
                check(f"capability {key} external declares contract_path",
                      isinstance(contract, str) and bool(contract), f"contract_path={contract!r}")
                if isinstance(contract, str) and contract:
                    cparts = contract.split("/")
                    check(f"capability {key} contract_path relative",
                          not os.path.isabs(contract) and ".." not in cparts, contract)
                    check(f"capability {key} contract_path exists",
                          os.path.isfile(os.path.join(ROOT, contract)), contract)
    return collected


def _executor_descriptor_ok(executor, entry: dict) -> bool:
    """Each executor requires exactly its own runner descriptor, and no other.

    Why "exactly": a github-actions automation that also carries a launchd block
    is two jobs described as one — the registry would answer "what runs this?"
    with two incompatible answers. Extra descriptors are stale metadata waiting
    to be trusted by the next reader.
    """
    has_workflow = isinstance(entry.get("workflow"), str) and entry.get("workflow")
    has_launchd = entry.get("launchd") is not None
    has_systemd = entry.get("systemd") is not None
    descriptors = (bool(has_workflow), bool(has_launchd), bool(has_systemd))
    if executor == "github-actions":
        return descriptors == (True, False, False)
    if executor == "launchd":
        return descriptors == (False, True, False)
    if executor == "systemd":
        return descriptors == (False, False, True)
    if executor == "human":
        return descriptors == (False, False, False)
    return False


def validate_automation_entries(reg: dict):
    """Validate automation record schema. Returns list of (key, entry).

    Common fields are required unconditionally. `workflow` and `launchd` are
    required *conditionally* by `executor`: an automation that omits both would
    pass a looser validator while pointing at nothing runnable, and the failure
    would only surface when the schedule silently stops producing data.
    """
    automations = reg.get("automations")
    if automations is None:
        check("automation registry has automations section", False, "missing section")
        return []
    if not isinstance(automations, dict):
        check("automation registry automations is a mapping", False, type(automations).__name__)
        return []
    collected = []
    for key, entry in automations.items():
        if not isinstance(entry, dict):
            check(f"automation record is a mapping: {key}", False, type(entry).__name__)
            continue
        collected.append((key, entry))
        check(f"automation {key} identifier kebab-case", bool(KEBAB_RE.match(key)), f"key={key!r}")
        for field in ("name", "path", "entrypoint", "status", "version", "updated",
                      "trigger_kind", "executor", "description"):
            value = entry.get(field)
            check(f"automation {key} has required field: {field}", value is not None,
                  f"value={value!r}")
            if value is not None:
                check(f"automation {key} required field is non-empty string: {field}",
                      isinstance(value, str) and len(value) > 0,
                      f"value={value!r} type={type(value).__name__}")
        check(f"automation {key} map key == name", key == entry.get("name"),
              f"key={key!r} name={entry.get('name')!r}")

        status = entry.get("status")
        if status is not None:
            check(f"automation {key} status legal", status in ALLOWED_AUTOMATION_STATUSES,
                  f"status={status!r}")
        trigger = entry.get("trigger_kind")
        if trigger is not None:
            check(f"automation {key} trigger_kind legal", trigger in ALLOWED_TRIGGER_KINDS,
                  f"trigger_kind={trigger!r}")
        executor = entry.get("executor")
        if executor is not None:
            check(f"automation {key} executor legal", executor in ALLOWED_EXECUTORS,
                  f"executor={executor!r}")
        version = entry.get("version")
        if version is not None:
            check(f"automation {key} version X.Y.Z",
                  isinstance(version, str) and bool(VERSION_RE.match(version)),
                  f"version={version!r}")
        updated = entry.get("updated")
        if updated is not None:
            check(f"automation {key} updated is YYYY-MM-DD",
                  isinstance(updated, str) and bool(DATE_RE.match(updated)),
                  f"updated={updated!r}")

        # path may be automations/<key> (flat) or automations/<family>/<member>
        # (one level of grouping), where the registry key is "<family>-<member>".
        # Either way the key is derivable from the path and the path from the key,
        # so "one directory = one asset = one tag" stays single-sourced: a family
        # groups assets, it never introduces a second name for one.
        # See automations/README.md, "Families".
        path = entry.get("path")
        if isinstance(path, str) and path:
            parts = path.split("/")
            flat_path = f"{AUTOMATION_DIR}/{key}"
            in_family = (
                len(parts) == 3
                and parts[0] == AUTOMATION_DIR
                and bool(KEBAB_RE.match(parts[1]))
                and bool(KEBAB_RE.match(parts[2]))
                # The registry key must remain derivable from the path, and the
                # path from the key: for a member the key is "<family>-<member>".
                # Allowing them to diverge would give one thing two names, which
                # is exactly the drift the rest of this file exists to prevent.
                and f"{parts[1]}-{parts[2]}" == key
            )
            check(
                f"automation {key} path is automations/<key> "
                f"or automations/<family>/<key> with key == <family>-<key>",
                path == flat_path or in_family,
                f"path={path!r}",
            )
            check(f"automation {key} path relative",
                  not os.path.isabs(path) and ".." not in parts, path)
            check(f"automation {key} path is a directory",
                  os.path.isdir(os.path.join(ROOT, path)), path)

        # entrypoint must exist inside the automation directory.
        entrypoint = entry.get("entrypoint")
        if isinstance(path, str) and path and isinstance(entrypoint, str) and entrypoint:
            check(f"automation {key} entrypoint has no path separators",
                  "/" not in entrypoint and "\\" not in entrypoint, entrypoint)
            entry_file = os.path.join(ROOT, path, entrypoint)
            check(f"automation {key} entrypoint exists", os.path.isfile(entry_file),
                  f"{path}/{entrypoint}")

        # executor decides which runner descriptor is required.
        check(f"automation {key} declares exactly the descriptor its executor needs",
              _executor_descriptor_ok(executor, entry), f"executor={executor!r}")
        if executor == "launchd":
            launchd = entry.get("launchd")
            if not isinstance(launchd, dict):
                check(f"automation {key} launchd is a mapping", False, type(launchd).__name__)
            else:
                unknown = set(launchd.keys()) - {"label", "template"}
                check(f"automation {key} launchd has only allowed keys", not unknown,
                      f"unknown fields: {sorted(unknown)}")
                label = launchd.get("label")
                check(f"automation {key} launchd label is non-empty string",
                      isinstance(label, str) and len(label) > 0, f"label={label!r}")
                template = launchd.get("template")
                check(f"automation {key} launchd template is non-empty string",
                      isinstance(template, str) and len(template) > 0, f"template={template!r}")
                if isinstance(template, str) and template:
                    tparts = template.split("/")
                    check(f"automation {key} launchd template relative",
                          not os.path.isabs(template) and ".." not in tparts, template)
                    template_file = os.path.join(ROOT, template)
                    texists = os.path.isfile(template_file)
                    check(f"automation {key} launchd template exists", texists, template)
                    if texists and isinstance(label, str) and label:
                        # The plist's own Label must match the declaration, or the
                        # installed job and the registry describe different jobs.
                        with open(template_file, encoding="utf-8") as handle:
                            plist_body = handle.read()
                        check(f"automation {key} launchd label matches plist",
                              f"<string>{label}</string>" in plist_body,
                              f"{template} does not declare Label {label!r}")

        # `external_trigger`: a file in this repository that shows what fires this
        # automation from outside the workflow — a server crontab, a systemd timer.
        #
        # Why it exists. The Automation Domain assumed GitHub was the only clock, so
        # `trigger_kind != manual` implied "the bound workflow declares a cron". GitHub's
        # scheduler turned out to fire 4-5 hours late in this repository, which for a job
        # that must land before a 09:00 consumer is the difference between today's data
        # and yesterday's. A server crontab calling `workflow_dispatch` fixes the timing,
        # and the workflow's own cron can then go away — but `manual` would be a lie:
        # nothing human triggers it.
        #
        # The field is a path, it must exist, and it must live inside the automation's
        # own directory. "Something else fires this" is an assertion; a file is evidence.
        external_trigger = entry.get("external_trigger")
        if external_trigger is not None:
            check(f"automation {key} external_trigger is a string",
                  isinstance(external_trigger, str) and bool(external_trigger.strip()),
                  repr(external_trigger)[:60])
            if isinstance(external_trigger, str) and external_trigger.strip():
                ext = external_trigger
                ext_parts = ext.split("/")
                check(f"automation {key} external_trigger relative",
                      not os.path.isabs(ext) and ".." not in ext_parts, ext)
                if isinstance(path, str) and path:
                    # 两个合法位置：
                    #   ① automation 自己的目录（历史位置，也是"这个 automation 自带钟"）
                    #   ② 服务器定时器总目录（所有项目的钟集中在一处，见 scripts/server-timers/）
                    #
                    # ② 是为了让人在一个地方看到"这台机器上到底有哪些钟"。
                    # 只允许这两个位置：别处出现的 external_trigger 大多是指错了。
                    in_own_dir = ext.startswith(path.rstrip("/") + "/")
                    in_timer_dir = ext.startswith("scripts/server-timers/timers/")
                    check(f"automation {key} external_trigger under its directory or the timer root",
                          in_own_dir or in_timer_dir,
                          f"{ext} is neither under {path} nor under scripts/server-timers/timers/")
                check(f"automation {key} external_trigger exists",
                      os.path.isfile(os.path.join(ROOT, ext)), ext)

        if executor == "systemd":
            systemd = entry.get("systemd")
            if not isinstance(systemd, dict):
                check(f"automation {key} systemd is a mapping", False, type(systemd).__name__)
            else:
                unknown = set(systemd.keys()) - {"unit", "timer"}
                check(f"automation {key} systemd has only allowed keys", not unknown,
                      f"unknown fields: {sorted(unknown)}")
                unit = systemd.get("unit")
                check(f"automation {key} systemd unit is non-empty string",
                      isinstance(unit, str) and len(unit) > 0, f"unit={unit!r}")
                timer = systemd.get("timer")
                if timer is not None:
                    check(f"automation {key} systemd timer is non-empty string",
                          isinstance(timer, str) and len(timer) > 0, f"timer={timer!r}")
                # A clock-driven systemd job with no timer is the same defect as a
                # workflow with no cron: nothing starts it, and the registry would
                # claim a cadence that no unit actually produces.
                if trigger not in ("manual", "event"):
                    check(f"automation {key} systemd declares a timer for a clock-driven job",
                          isinstance(timer, str) and len(timer) > 0,
                          f"trigger_kind={trigger!r} but no systemd.timer")

        # workflow must live under .github/workflows/ and exist.
        workflow = entry.get("workflow")
        if isinstance(workflow, str) and workflow:
            parts = workflow.split("/")
            check(f"automation {key} workflow relative",
                  not os.path.isabs(workflow) and ".." not in parts, workflow)
            check(f"automation {key} workflow under {AUTOMATION_WORKFLOW_PREFIX}",
                  workflow.startswith(AUTOMATION_WORKFLOW_PREFIX), workflow)
            workflow_file = os.path.join(ROOT, workflow)
            exists = os.path.isfile(workflow_file)
            check(f"automation {key} workflow exists", exists, workflow)
            if exists:
                # Text-level checks on purpose: PyYAML parses a bare `on:` key as
                # boolean True (YAML 1.1), so parsing the workflow would need
                # special-casing for the very block we care about.
                with open(workflow_file, encoding="utf-8") as handle:
                    body = handle.read()
                # A time-triggered automation must have *something* that fires it.
                # That used to mean only "the workflow declares a cron"; with
                # `external_trigger` it can also mean "a descriptor in this
                # repository shows the external clock". Either satisfies the
                # original concern: no job that silently nothing starts.
                if trigger != "manual" and not external_trigger:
                    check(f"automation {key} workflow declares schedule:",
                          "schedule:" in body,
                          f"{workflow} has no schedule: block but trigger_kind={trigger!r}")
                if isinstance(path, str) and path:
                    check(f"automation {key} workflow references its directory",
                          path in body, f"{workflow} never mentions {path}")

        # output contract: the data branch and a path pattern are both required.
        output = entry.get("output")
        if output is None:
            check(f"automation {key} has output contract", False, "missing output")
        elif not isinstance(output, dict):
            check(f"automation {key} output is a mapping", False, type(output).__name__)
        else:
            target = output.get("target")
            check(f"automation {key} output target legal",
                  target in ALLOWED_OUTPUT_TARGETS, f"target={target!r}")
            if target == "git-branch":
                unknown = set(output.keys()) - {"target", "branch", "path_pattern"}
                check(f"automation {key} output has only allowed keys", not unknown,
                      f"unknown fields: {sorted(unknown)}")
                branch = output.get("branch")
                check(f"automation {key} output branch is {AUTOMATION_OUTPUT_BRANCH}",
                      branch == AUTOMATION_OUTPUT_BRANCH, f"branch={branch!r}")
                pattern = output.get("path_pattern")
                check(f"automation {key} output path_pattern is non-empty string",
                      isinstance(pattern, str) and len(pattern) > 0, f"pattern={pattern!r}")
                if isinstance(pattern, str) and pattern:
                    # NOTE: path_pattern is the location INSIDE the output branch,
                    # which has its own namespace unrelated to main's layout.
                    # Requiring it under automations/ would be wrong — the only
                    # constraints are relative + no traversal.
                    pattern_parts = pattern.split("/")
                    check(f"automation {key} output path_pattern is relative with no '..'",
                          not os.path.isabs(pattern) and ".." not in pattern_parts, pattern)
            elif target == "local-file":
                unknown = set(output.keys()) - {"target", "path", "retention", "human_access"}
                check(f"automation {key} output has only allowed keys", not unknown,
                      f"unknown fields: {sorted(unknown)}")
                out_path = output.get("path")
                check(f"automation {key} output path is non-empty string",
                      isinstance(out_path, str) and len(out_path.strip()) > 0,
                      f"path={out_path!r}")
                if isinstance(out_path, str) and out_path.strip():
                    check(f"automation {key} output path has no '..'",
                          ".." not in out_path.split("/"), out_path)
                # Retention is mandatory, not advised: an unbounded artifact directory
                # on a server is a disk-full incident scheduled for some future month.
                retention = output.get("retention")
                check(f"automation {key} output retention is a positive integer",
                      isinstance(retention, int) and not isinstance(retention, bool)
                      and retention > 0, f"retention={retention!r}")
                # human_access is mandatory because an artifact nobody can find is not
                # delivered. This is the same rule as "a destination must name a real
                # place" for external-system — the most the validator can honestly ask.
                access = output.get("human_access")
                check(f"automation {key} output human_access says how to reach it",
                      isinstance(access, str) and len(access.strip()) >= 8,
                      f"human_access={access!r}")
            elif target == "external-system":
                unknown = set(output.keys()) - {"target", "destination"}
                check(f"automation {key} output has only allowed keys", not unknown,
                      f"unknown fields: {sorted(unknown)}")
                destination = output.get("destination")
                # Not machine-checkable from this repository: the destination is
                # another system. Requiring it to be specific is the most the
                # validator can honestly do.
                check(f"automation {key} output destination names a real place",
                      isinstance(destination, str) and len(destination.strip()) >= 8,
                      f"destination={destination!r}")
    return collected


def discover_skill_packages():
    """Find skill packages on disk that contain SKILL.md.

    Flat layout only: `skills/<name>/`. Deliberately NOT recursive — Agent
    Plugins v1 §7.1 forbids clients from searching deeper descendants, so a
    nested package is not a discoverable skill and must not be treated as one
    here either (otherwise the validator would certify an asset that conformant
    clients cannot see)."""
    found = []
    base = os.path.join(ROOT, "skills")
    if os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            if name.startswith("."):
                continue
            if os.path.isfile(os.path.join(base, name, "SKILL.md")):
                found.append(f"skills/{name}")
    return found


def find_misplaced_skill_packages():
    """Find every SKILL.md that is NOT at the flat position `skills/<name>/`.

    `discover_skill_packages` above is deliberately non-recursive, which is
    correct but leaves a blind spot: a package sitting at e.g.
    `skills/shared/ghost/SKILL.md` is invisible to conformant clients (Agent
    Plugins v1 §7.1 forbids recursion) AND was invisible to this validator, so
    it passed as a clean run while being uninstallable. That is a silent
    failure — the package exists on disk, no client can load it, and nothing
    says so. This walks the whole tree to close that gap.

    Documented as Issue #2 item 4 and deferred on 2026-10-01; the impact grew
    once the flat layout became mandatory, because any nesting is now
    unambiguously wrong rather than merely unconventional."""
    misplaced = []
    base = os.path.join(ROOT, "skills")
    if not os.path.isdir(base):
        return misplaced
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if "SKILL.md" not in filenames:
            continue
        rel = os.path.relpath(dirpath, ROOT).replace(os.sep, "/")
        parts = rel.split("/")
        if len(parts) == 2 and parts[0] == "skills":
            continue  # correct flat position
        misplaced.append(rel)
    return sorted(misplaced)


def main() -> int:
    # ---- 1. Top-level registry (root must be a mapping) ----
    top, ok = load_yaml("registry.yaml")
    if not ok:
        return report(1)
    top = check_mapping(top, "top-level registry")
    if top is None:
        return report(1)
    check("top-level registry schema_version", top.get("schema_version") == STORE_SCHEMA_VERSION,
          f"got {top.get('schema_version')!r} (expected {STORE_SCHEMA_VERSION})")
    store_block = top.get("store")
    if isinstance(store_block, dict):
        check("top-level store name", store_block.get("name") == STORE_NAME,
              repr(store_block.get("name")))
        check("top-level store owner", store_block.get("owner") == STORE_OWNER,
              repr(store_block.get("owner")))
        check("top-level store has only allowed keys",
              set(store_block.keys()) <= {"name", "owner"},
              f"unexpected keys: {sorted(set(store_block.keys()) - {'name', 'owner'})}")
    else:
        check("top-level store is a mapping", False, type(store_block).__name__)
    # Closed top-level schema: the router must NOT carry domain-owned state
    # (e.g. capabilities:, skill lifecycle metadata). Only router fields live here.
    check("top-level registry has only allowed keys",
          set(top.keys()) <= {"schema_version", "store", "registries"},
          f"unexpected keys: {sorted(set(top.keys()) - {'schema_version', 'store', 'registries'})}")

    # ---- 2. Router values: safe route resolution ----
    # Only paths that pass Route Safety Validation may be loaded / scanned.
    refs = check_mapping(top.get("registries"), "top-level registries")
    if refs is None:
        return report(1)
    expected_domains = ("skills", "external_capabilities", "dependencies", "automations",
                       "orchestrations")
    check("top-level registry routes all domains", set(refs.keys()) == set(expected_domains),
          f"routes: {sorted(refs.keys())}")
    routed = {}
    for domain in expected_domains:
        routed[domain] = validate_and_resolve_route(domain, refs.get(domain))
    # Uniqueness is checked on NORMALIZED validated paths: external-capabilities/registry.yaml
    # and external-capabilities/../external-capabilities/registry.yaml resolve to
    # the same file and must be treated as a duplicate.
    norm_paths = [routed[d] for d in expected_domains if routed[d]]
    check("registry paths not duplicated (normalized)",
          len(norm_paths) == len(set(norm_paths)),
          "duplicate registry path in top-level registries")

    def _routed(domain):
        """Validated (safe) relative repo path for a domain, or None."""
        return routed.get(domain)

    # Load domain registries THROUGH the validated router values
    # (router = source of truth). Each root must be a mapping.
    skills_rel = _routed("skills")
    skills_reg, skills_ok = load_yaml(skills_rel) if skills_rel else (None, False)
    if skills_ok:
        skills_reg = check_mapping(skills_reg, "skills registry")
        skills_ok = skills_reg is not None
    caps_rel = _routed("external_capabilities")
    caps_reg, caps_ok = load_yaml(caps_rel) if caps_rel else (None, False)
    if caps_ok:
        caps_reg = check_mapping(caps_reg, "capability registry")
        caps_ok = caps_reg is not None
    deps_rel = _routed("dependencies")
    deps_reg, deps_ok = load_yaml(deps_rel) if deps_rel else (None, False)
    if deps_ok:
        deps_reg = check_mapping(deps_reg, "dependency registry")
        deps_ok = deps_reg is not None
    autos_rel = _routed("automations")
    autos_reg, autos_ok = load_yaml(autos_rel) if autos_rel else (None, False)
    if autos_ok:
        autos_reg = check_mapping(autos_reg, "automation registry")
        autos_ok = autos_reg is not None
    orc_rel = _routed("orchestrations")
    orc_reg, orc_ok = load_yaml(orc_rel) if orc_rel else (None, False)
    if orc_ok:
        orc_reg = check_mapping(orc_reg, "orchestration registry")
        orc_ok = orc_reg is not None

    # ---- 3. Domain registry headers ----
    if skills_ok:
        check("skills registry schema_version", skills_reg.get("schema_version") == 2,
              f"got {skills_reg.get('schema_version')!r} (expected 2: flat skills map)")
        check("skills registry domain", skills_reg.get("domain") == "skills",
              repr(skills_reg.get("domain")))
    if caps_ok:
        check("capability registry schema_version", caps_reg.get("schema_version") == 1,
              f"got {caps_reg.get('schema_version')!r}")
        check("capability registry domain", caps_reg.get("domain") == "external_capabilities",
              repr(caps_reg.get("domain")))
    if deps_ok:
        check("dependency registry schema_version", deps_reg.get("schema_version") == 1,
              f"got {deps_reg.get('schema_version')!r}")
    if autos_ok:
        check("automation registry schema_version", autos_reg.get("schema_version") == 2,
              f"got {autos_reg.get('schema_version')!r}")
        check("automation registry domain", autos_reg.get("domain") == "automations",
              repr(autos_reg.get("domain")))
        allowed_auto = set(autos_reg.get("allowed_statuses") or [])
        check("automation registry keeps 5 lifecycle statuses",
              allowed_auto == ALLOWED_AUTOMATION_STATUSES, f"allowed={sorted(allowed_auto)}")
        allowed_trigger = set(autos_reg.get("allowed_trigger_kinds") or [])
        check("automation registry keeps 6 trigger kinds",
              allowed_trigger == ALLOWED_TRIGGER_KINDS, f"kinds={sorted(allowed_trigger)}")
        allowed_execs = set(autos_reg.get("allowed_executors") or [])
        check("automation registry keeps 4 executors",
              allowed_execs == ALLOWED_EXECUTORS, f"executors={sorted(allowed_execs)}")
        check("dependency registry dependencies is a list",
              isinstance(deps_reg.get("dependencies"), list),
              type(deps_reg.get("dependencies")).__name__)

    # ---- 4/5. Skill registry schema + paths ----
    skill_entries = validate_skill_entries(skills_reg) if skills_ok else []
    if skills_ok:
        allowed = set(skills_reg.get("allowed_statuses") or [])
        check("skills registry keeps 5 lifecycle statuses", allowed == ALLOWED_SKILL_STATUSES,
              f"allowed={sorted(allowed)}")
    for key, entry in skill_entries:
        validate_skill_path(key, entry)
        skill_path = entry.get("path")
        if isinstance(skill_path, str) and skill_path:
            validate_skill_frontmatter(key, os.path.join(ROOT, skill_path))

    # ---- 6. Registry <-> filesystem symmetry ----
    registered_paths = set()
    for key, entry in skill_entries:
        path = entry.get("path")
        if isinstance(path, str) and path:
            registered_paths.add(path.rstrip("/"))
    for rel in discover_skill_packages():
        check(f"filesystem skill is registered: {rel}", rel in registered_paths,
              "package directory exists but has no registry entry")

    # ---- 6a-bis. No nested (misplaced) skill packages ----
    # A SKILL.md below skills/<name>/ is invisible to conformant clients, so it
    # must be reported rather than silently ignored. See
    # find_misplaced_skill_packages() and Issue #2 item 4.
    misplaced = find_misplaced_skill_packages()
    check("no nested skill packages under skills/", not misplaced,
          "misplaced SKILL.md found at " + ", ".join(misplaced)
          + " — the flat layout is skills/<name>/ (exactly one level); "
            "Agent Plugins v1 §7.1 forbids clients from recursing, so a nested "
            "package is uninstallable")

    # ---- 6b. Filesystem skill directory naming (kebab-case) ----
    # Flat layout: every real directory under skills/ is a skill package.
    skills_base = os.path.join(ROOT, "skills")
    if os.path.isdir(skills_base):
        for name in sorted(os.listdir(skills_base)):
            if name.startswith("."):
                continue
            if not os.path.isdir(os.path.join(skills_base, name)):
                continue  # metadata files (e.g. README.md) are not skill packages
            check(f"filesystem skill directory kebab-case: skills/{name}",
                  bool(KEBAB_RE.match(name)), name)

    # ---- 8/9. Capability schema + provider naming ----
    cap_entries = validate_capability_entries(caps_reg) if caps_ok else []
    if caps_ok:
        allowed_types = set(caps_reg.get("allowed_types") or [])
        allowed_statuses = set(caps_reg.get("allowed_statuses") or [])
        check("capability registry supports 6 types", allowed_types == ALLOWED_CAPABILITY_TYPES,
              f"types={sorted(allowed_types)}")
        check("capability registry keeps 5 statuses", allowed_statuses == ALLOWED_CAPABILITY_STATUSES,
              f"statuses={sorted(allowed_statuses)}")
    providers_dir = os.path.join(ROOT, "external-capabilities/providers")
    if os.path.isdir(providers_dir):
        for name in sorted(os.listdir(providers_dir)):
            if name.startswith("."):
                continue
            check(f"provider directory kebab-case: {name}", bool(KEBAB_RE.match(name)), name)

    # ---- 10/11. Dependency registry parsing + foreign keys ----
    skill_ids = {key for key, _ in skill_entries}
    capability_ids = {key for key, _ in cap_entries}
    if deps_ok:
        deps = deps_reg.get("dependencies")
        if isinstance(deps, list):
            seen_skills = set()
            for i, dep in enumerate(deps):
                if not isinstance(dep, dict):
                    check(f"dependency {i} is a mapping", False, type(dep).__name__)
                    continue
                # Enforce the dependency entry schema: only skill + requires are
                # allowed. Fields such as skill_version or type would recreate a
                # second source of truth and are rejected.
                unknown_dep = set(dep.keys()) - {"skill", "requires"}
                check(f"dependency {i} has only allowed fields", not unknown_dep,
                      f"unknown fields: {sorted(unknown_dep)}")
                skill = dep.get("skill")
                check(f"dependency {i} has skill", isinstance(skill, str) and skill,
                      f"skill={skill!r}")
                if isinstance(skill, str) and skill:
                    check(f"dependency {i} skill exists in skills registry",
                          skill in skill_ids, f"skill={skill!r}")
                    # Uniqueness: one dependency entry per skill.
                    check(f"dependency {i} skill unique in list", skill not in seen_skills,
                          f"duplicate dependency for skill={skill!r}")
                    seen_skills.add(skill)
                requires = dep.get("requires")
                check(f"dependency {i} requires is a list", isinstance(requires, list),
                      type(requires).__name__)
                if isinstance(requires, list):
                    seen_caps = set()
                    for j, req in enumerate(requires):
                        if not isinstance(req, dict):
                            check(f"dependency {i}.requires[{j}] is a mapping", False,
                                  type(req).__name__)
                            continue
                        unknown_req = set(req.keys()) - {"capability", "required", "notes"}
                        check(f"dependency {i}.requires[{j}] has only allowed fields",
                              not unknown_req, f"unknown fields: {sorted(unknown_req)}")
                        cap = req.get("capability")
                        check(f"dependency {i}.requires[{j}] has capability",
                              isinstance(cap, str) and cap, f"capability={cap!r}")
                        if isinstance(cap, str) and cap:
                            check(f"dependency {i}.requires[{j}] capability exists in capability registry",
                                  cap in capability_ids, f"capability={cap!r}")
                            # Uniqueness: one requirement entry per capability within a skill.
                            check(f"dependency {i}.requires[{j}] capability unique in skill",
                                  cap not in seen_caps,
                                  f"duplicate requirement for capability={cap!r}")
                            seen_caps.add(cap)
                        required = req.get("required")
                        check(f"dependency {i}.requires[{j}] required is a boolean",
                              isinstance(required, bool), repr(required))

    # ---- 12b. Capability shelves: every directory is a registered asset ----
    # `providers/` and `use-cases/` hold documents, not capabilities, and are
    # reserved. Every other directory under external-capabilities/ is a shelf
    # grouping implementations, and is therefore CLOSED: each child must appear
    # as some entry's `implementation_path`.
    #
    # This closes the gap `connectors/investdesk-bot` exposed. Fourteen files
    # (Dockerfile, compose file, deploy script, sources) sat in the tree with no
    # registry entry. Every schema check iterates entries, so nothing looked at
    # it; every tag check iterates entries, so nothing looked at it either; and
    # the validator reported a clean run. A directory nobody registered is an
    # asset nobody governs.
    #
    # An unrecognised shelf is a hard error, not a skip: adding a shelf is a
    # policy decision worth reviewing, and it should not arrive by someone
    # creating a directory.
    if caps_ok:
        registered_impls = set()
        for _cap_key, _cap_entry in cap_entries:
            _impl = _cap_entry.get("implementation_path")
            if isinstance(_impl, str) and _impl:
                registered_impls.add(_impl.rstrip("/"))
        caps_base = os.path.join(ROOT, "external-capabilities")
        if os.path.isdir(caps_base):
            for name in sorted(os.listdir(caps_base)):
                if name.startswith("."):
                    continue
                full = os.path.join(caps_base, name)
                if not os.path.isdir(full):
                    continue
                rel = f"external-capabilities/{name}"
                if name in RESERVED_CAPABILITY_DIRS:
                    continue
                check(f"capability shelf is declared: {rel}", name in CAPABILITY_SHELVES,
                      f"unknown shelf {name!r} — declare it as a shelf or a reserved "
                      f"directory in scripts/validate_store.py")
                if name not in CAPABILITY_SHELVES:
                    continue
                for child in sorted(os.listdir(full)):
                    if child.startswith(".") or child in NON_ASSET_DIR_NAMES:
                        continue
                    child_full = os.path.join(full, child)
                    if not os.path.isdir(child_full):
                        continue

                    # 生态层：名字在 CAPABILITY_ECOSYSTEMS 里就当成"生态"而不是资产，
                    # 往下再走一层。两层的规则完全一样（kebab + 必须已注册），
                    # 所以一个生态里偷偷放个未登记的目录，一样会被抓住。
                    if child in CAPABILITY_ECOSYSTEMS:
                        for asset in sorted(os.listdir(child_full)):
                            if asset.startswith(".") or asset in NON_ASSET_DIR_NAMES:
                                continue
                            if not os.path.isdir(os.path.join(child_full, asset)):
                                continue
                            asset_rel = f"{rel}/{child}/{asset}"
                            check(f"capability directory kebab-case: {asset_rel}",
                                  bool(KEBAB_RE.match(asset)), asset)
                            check(f"capability directory is registered: {asset_rel}",
                                  asset_rel in registered_impls,
                                  "directory exists under a capability ecosystem but no "
                                  "registry entry points at it")
                        continue

                    child_rel = f"{rel}/{child}"
                    check(f"capability directory kebab-case: {child_rel}",
                          bool(KEBAB_RE.match(child)), child)
                    check(f"capability directory is registered: {child_rel}",
                          child_rel in registered_impls,
                          "directory exists under a capability shelf but no registry "
                          "entry points at it")

    # ---- 13. Automation schema + registry <-> filesystem symmetry ----
    auto_entries = validate_automation_entries(autos_reg) if autos_ok else []
    registered_auto_paths = set()
    for key, entry in auto_entries:
        entry_path = entry.get("path")
        if isinstance(entry_path, str) and entry_path:
            registered_auto_paths.add(entry_path.rstrip("/"))
    automations_base = os.path.join(ROOT, AUTOMATION_DIR)
    if os.path.isdir(automations_base):
        for name in sorted(os.listdir(automations_base)):
            if name.startswith("."):
                continue
            full = os.path.join(automations_base, name)
            if not os.path.isdir(full):
                continue  # metadata files (README.md, registry.yaml) are not automations
            rel = f"{AUTOMATION_DIR}/{name}"
            check(f"filesystem automation directory kebab-case: {rel}",
                  bool(KEBAB_RE.match(name)), name)

            if rel in registered_auto_paths:
                # Flat automation. Its own contents are its business: the Store
                # fixes an asset's location, not its internal source layout.
                continue

            # Not registered itself, so the only other legal shape is a family
            # container. Every member directory must be a registered automation.
            members = sorted(
                d
                for d in os.listdir(full)
                if not d.startswith(".")
                and d not in NON_ASSET_DIR_NAMES
                and os.path.isdir(os.path.join(full, d))
            )
            check(f"filesystem directory {rel} is a registered automation or a family",
                  bool(members),
                  "directory is neither registered nor a container of member directories")
            if not members:
                continue

            # A family has no key, no version and no tag. README.md is the only
            # place that can record why these members live together — without it
            # the container is a directory with no reason to exist.
            check(f"family {rel} documents itself in README.md",
                  os.path.isfile(os.path.join(full, "README.md")),
                  "a family container is not a registry entry; README.md is its only record")

            for member in members:
                member_rel = f"{rel}/{member}"
                check(f"filesystem automation directory kebab-case: {member_rel}",
                      bool(KEBAB_RE.match(member)), member)
                check(f"family member is a registered automation: {member_rel}",
                      member_rel in registered_auto_paths,
                      "family member directory has no registry entry")
    for rel in sorted(registered_auto_paths):
        check(f"registered automation exists on disk: {rel}",
              os.path.isdir(os.path.join(ROOT, rel)),
              "registry entry points at a missing directory")

    # A registered path may not be a prefix of another registered path: the walk
    # above stops at a registered directory, so anything nested under one would
    # never be checked.
    for outer in sorted(registered_auto_paths):
        for inner in sorted(registered_auto_paths):
            if outer != inner:
                check(f"registered automation paths are not nested: {outer} / {inner}",
                      not inner.startswith(outer + "/"),
                      f"{inner} is nested under the registered automation {outer}")

    # ---- Required policy / asset files ----
    for rel in REQUIRED_POLICY_FILES:
        check(f"required asset exists: {rel}", os.path.exists(os.path.join(ROOT, rel)))

    # ---- 12. Lightweight secret scan, following the router (reference metadata exempt) ----
    # The top-level registry.yaml plus every ROUTE-SAFETY-VALIDATED domain
    # registry are scanned, so structured validation and security validation
    # read the same (safe) sources. Invalid routes are never scanned.
    scan_targets = ["registry.yaml"]
    for domain in expected_domains:
        rel = _routed(domain)
        if rel:
            scan_targets.append(rel)
    for rel in scan_targets:
        scan_for_secrets(rel)

    # ---- 14. Orchestration Domain ----
    validate_orchestrations(orc_reg if orc_ok else {})

    # ---- 15. 服务器定时器 ----
    validate_server_timers()

    return report(0)


def validate_server_timers() -> None:
    """服务器定时器：两件"看起来正常、实际没产出"的事。

    ① 每个 .cron 里引用的 workflow 必须真的存在。
       `.cron` 只是给 cron 读的文本，没有任何东西会把它的 workflow 名和
       .github/workflows/ 下的实际文件对上。名字写错不会报错 —— cron 照常到点
       执行，脚本照常 POST，GitHub 返回 404，而那行日志没人看。

    ② workflow 的 dry-run 默认 true 时，cron 必须显式传 `{"dry-run":false}`。
       GitHub 对 workflow_dispatch 里没传的输入使用 workflow 声明的默认值：
       省略 inputs → 204 → 正常结束 → 什么都不写。这条检查防的是
       "定时任务每周都在跑、每次都成功、就是没有产出"。
    """
    timers_dir = os.path.join(ROOT, "scripts", "server-timers", "timers")
    workflows_dir = os.path.join(ROOT, ".github", "workflows")
    if not os.path.isdir(timers_dir):
        return
    dispatch_re = re.compile(r"ai-capability-store-dispatch\s+([a-z0-9-]+\.yml)([^\n]*)")
    dry_false_re = re.compile(r"[\"']?dry-run[\"']?\s*:\s*false")
    for name in sorted(os.listdir(timers_dir)):
        if not name.endswith(".cron"):
            continue
        rel = f"scripts/server-timers/timers/{name}"
        try:
            body = open(os.path.join(timers_dir, name), encoding="utf-8").read()
        except OSError:
            check(f"server timer readable: {rel}", False, "unreadable")
            continue
        for match in dispatch_re.finditer(body):
            workflow, rest = match.group(1), match.group(2)
            check(f"server timer {name} dispatches an existing workflow",
                  os.path.isfile(os.path.join(workflows_dir, workflow)),
                  f"{workflow} 不存在于 .github/workflows/ —— 这个定时器到点会 404")
            if not os.path.isfile(os.path.join(workflows_dir, workflow)):
                continue
            wf_data, wf_ok = load_yaml(f".github/workflows/{workflow}")
            if not wf_ok or not isinstance(wf_data, dict):
                continue
            # PyYAML 把 YAML 1.1 的 `on:` 解析成布尔 True；引号写法才是字符串。
            on = wf_data.get(True) if True in wf_data else wf_data.get("on")
            wd = on.get("workflow_dispatch") if isinstance(on, dict) else None
            inputs = wd.get("inputs") if isinstance(wd, dict) else None
            dry = inputs.get("dry-run") if isinstance(inputs, dict) else None
            dry_defaults_true = isinstance(dry, dict) and dry.get("default") is True
            if dry_defaults_true:
                check(f"server timer {name} passes dry-run=false for {workflow}",
                      bool(dry_false_re.search(rest)),
                      f"{workflow} 的 dry-run 默认 true；定时触发省略 inputs 时只会演练、"
                      f"不会写 —— 在 cron 行里显式传 main '{{\"dry-run\":false}}'")


def validate_orchestrations(orc_reg: dict) -> None:
    """编排域：一次任务按什么顺序、用哪些已登记的资产。

    它只引用，不复制 —— 所以这里查的全是【引用是否成立】，不是内容：

      · use 指向的路径真的注册过（Skill 的 path / Capability 的 implementation_path）
      · 目录里的软链存在、不是断链、且目标等于 use
      · needs 指向的 id 存在
      · 没有环（Kahn 拓扑排序能跑完）
      · 没有孤儿（所有步骤都能从入口到达）

    service-call 模式额外查【边界两侧的交接】，因为那一段最容易安静地坏掉：

      · execution.requires 是合法能力项、必须含 network
      · execution.egress 是域名列表
      · 至少一步声明 calls，且 calls.service 是已登记的 external 能力
      · calls.contract 存在，且与服务记录的 contract_path 是同一份
      · 服务端点的域名必须出现在 egress 里（声明了才允许出网）

    后三条不是洁癖。软链断了 git 不会告诉你 —— 实测删掉目标之后 git status 是干净的，
    软链仍然指着不存在的地方。而环和孤儿会让"编排"退化成一张读不懂的图。
    """
    known = set()
    capabilities = {}
    for rel, section in (("skills/registry.yaml", "skills"),
                         ("external-capabilities/registry.yaml", "capabilities"),
                         # 编排可以引用一个 automation：它的第一步就是"敲钟+执行"，
                         # 而那件事整个装在 automation 里。
                         ("automations/registry.yaml", "automations")):
        data, ok = load_yaml(rel)
        if not ok or not isinstance(data, dict):
            continue
        for key, entry in (data.get(section) or {}).items():
            if not isinstance(entry, dict):
                continue
            if section == "capabilities":
                capabilities[key] = entry
            for field in ("path", "implementation_path"):
                value = entry.get(field)
                if isinstance(value, str) and value:
                    known.add(value.rstrip("/"))

    entries = orc_reg.get(ORCHESTRATION_DIR) or {}
    check("orchestration registry declares orchestrations", isinstance(entries, dict),
          type(entries).__name__)
    if not isinstance(entries, dict):
        return

    declared = set()
    for name, entry in entries.items():
        check(f"orchestration {name} kebab-case", bool(KEBAB_RE.match(name)), name)
        if not isinstance(entry, dict):
            check(f"orchestration {name} is a mapping", False, type(entry).__name__)
            continue
        # 登记的路径（三层），文件系统遍历时拿它比对
        if isinstance(entry.get("path"), str):
            declared.add(entry["path"].rstrip("/"))

        status = entry.get("status")
        check(f"orchestration {name} status legal", status in ALLOWED_ORCHESTRATION_STATUSES,
              f"status={status!r}")
        version = entry.get("version")
        check(f"orchestration {name} version is X.Y.Z",
              isinstance(version, str) and bool(VERSION_RE.match(version)), f"version={version!r}")
        path = entry.get("path")
        parts = path.split("/") if isinstance(path, str) else []
        check(f"orchestration {name} path is <mode>/<target>/<name>",
              len(parts) == 4 and parts[0] == ORCHESTRATION_DIR
              and parts[1] in ORCHESTRATION_MODES
              and parts[2] in ORCHESTRATION_ECOSYSTEMS
              and parts[3] == name,
              f"path={path!r} — 期望 {ORCHESTRATION_DIR}/<mode>/<target>/{name}")

        mode = parts[1] if len(parts) == 4 else None
        trigger = entry.get("trigger")
        if trigger is not None:
            check(f"orchestration {name} trigger legal",
                  trigger in ALLOWED_ORCHESTRATION_TRIGGERS,
                  f"trigger={trigger!r} (expected one of {sorted(ALLOWED_ORCHESTRATION_TRIGGERS)})")
        requires, egress = None, None
        if mode == "service-call":
            # 这个模式不回答"谁发起"（人问的、宿主定时任务叫醒的都有），
            # 所以 trigger 必须在这里写下来，否则"它也是定时的"这个事实就丢了。
            check(f"orchestration {name} service-call declares trigger",
                  isinstance(trigger, str) and bool(trigger), f"trigger={trigger!r}")
            execution = entry.get("execution")
            check(f"orchestration {name} service-call declares execution",
                  isinstance(execution, dict), f"execution={execution!r}")
            if isinstance(execution, dict):
                requires = execution.get("requires")
                check(f"orchestration {name} execution.requires is a non-empty list",
                      isinstance(requires, list) and bool(requires), f"requires={requires!r}")
                if isinstance(requires, list):
                    for req in requires:
                        check(f"orchestration {name} host requirement is declared: {req}",
                              req in ALLOWED_HOST_REQUIREMENTS, f"requires={requires!r}")
                    # 服务调用的前提就是能出网；不写 network 等于声明一条跑不了的链。
                    check(f"orchestration {name} service-call requires network",
                          "network" in requires, f"requires={requires!r}")
                egress = execution.get("egress")
                check(f"orchestration {name} execution.egress is a non-empty list",
                      isinstance(egress, list) and bool(egress), f"egress={egress!r}")
                if isinstance(egress, list):
                    for domain in egress:
                        check(f"orchestration {name} egress is a domain: {domain}",
                              isinstance(domain, str) and bool(EGRESS_RE.match(domain)),
                              f"egress={egress!r}")
            else:
                egress = None

        steps = entry.get("steps")
        if not isinstance(steps, list) or not steps:
            check(f"orchestration {name} declares steps", False, f"steps={steps!r}")
            continue

        ids, needs_by, links = [], {}, {}
        called = {}
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                check(f"orchestration {name} step {index} is a mapping", False, type(step).__name__)
                continue
            sid = step.get("id")
            check(f"orchestration {name} step {index} id is kebab-case",
                  isinstance(sid, str) and bool(KEBAB_RE.match(sid)), f"id={sid!r}")
            if not isinstance(sid, str) or not sid:
                continue
            ids.append(sid)
            needs_by[sid] = set(step.get("needs") or [])
            links[sid] = step.get("link")

            use = step.get("use")
            check(f"orchestration {name} step {sid} uses a registered asset",
                  isinstance(use, str) and use.rstrip("/") in known,
                  f"use={use!r} — 不指向任何已登记的 Skill path 或 Capability implementation_path")

            # calls：这一步的 SOP 会调一个店外服务。它不能被写成 use —— 店外服务
            # 没有 implementation_path，不是可引用的落地资产；它是这一步的运行时依赖。
            calls = step.get("calls")
            if calls is not None:
                called[sid] = calls
                check(f"orchestration {name} step {sid} calls only in service-call mode",
                      mode == "service-call", f"mode={mode!r}")
                check(f"orchestration {name} step {sid} calls is a mapping",
                      isinstance(calls, dict), type(calls).__name__)
                if isinstance(calls, dict):
                    service = calls.get("service")
                    check(f"orchestration {name} step {sid} calls a declared service",
                          isinstance(service, str) and service in capabilities,
                          f"service={service!r} — 不在 external-capabilities/registry.yaml 里")
                    contract = calls.get("contract")
                    check(f"orchestration {name} step {sid} calls declares contract",
                          isinstance(contract, str) and bool(contract), f"contract={contract!r}")
                    if isinstance(contract, str) and contract:
                        check(f"orchestration {name} step {sid} contract exists",
                              os.path.isfile(os.path.join(ROOT, contract)), contract)
                    endpoints = calls.get("endpoints")
                    check(f"orchestration {name} step {sid} calls declares endpoints",
                          isinstance(endpoints, list) and bool(endpoints), f"endpoints={endpoints!r}")

            link = step.get("link")
            base = os.path.join(ROOT, *parts) if len(parts) == 4 else os.path.join(ROOT, ORCHESTRATION_DIR, name)
            link_path = os.path.join(base, link) if isinstance(link, str) and link else None
            if link_path is None:
                check(f"orchestration {name} step {sid} declares a link", False, f"link={link!r}")
                continue
            check(f"orchestration {name} step {sid} link exists",
                  os.path.lexists(link_path), str(link))
            if not os.path.lexists(link_path):
                continue
            check(f"orchestration {name} step {sid} link is a symlink",
                  os.path.islink(link_path), f"{link} 不是软链")
            check(f"orchestration {name} step {sid} link is not dangling",
                  os.path.exists(link_path), f"{link} 是断链")
            if os.path.islink(link_path) and isinstance(use, str) and use:
                target = os.readlink(link_path)
                resolved = os.path.normpath(os.path.join(os.path.dirname(link_path), target))
                check(f"orchestration {name} step {sid} link matches use",
                      os.path.relpath(resolved, ROOT).replace(os.sep, "/") == use.rstrip("/"),
                      f"{link} → {target}，但 use 是 {use}")

        # 服务调用必须落在编排上：一条 service-call 编排至少要有一段 calls。
        if mode == "service-call":
            check(f"orchestration {name} service-call has a service call",
                  bool(called), "没有一步声明 calls —— 那它就不是 service-call")
        for sid, calls in called.items():
            if not isinstance(calls, dict):
                continue
            service = calls.get("service")
            cap = capabilities.get(service) if isinstance(service, str) else None
            if not isinstance(cap, dict):
                continue
            # 只有店外服务才配 calls：店里的能力有 implementation_path，
            # 应该用 use 引用它，而不是在这里重复登记一次调用。
            check(f"orchestration {name} step {sid} service is externally hosted",
                  cap.get("hosting") == "external",
                  f"service={service!r} hosting={cap.get('hosting')!r}")
            endpoint = cap.get("endpoint")
            host = urlparse(endpoint).netloc.split(":")[0].lower() if isinstance(endpoint, str) else ""
            check(f"orchestration {name} step {sid} service host is declared in egress",
                  isinstance(egress, list) and host in egress,
                  f"service host={host!r} execution.egress={egress!r}")
            # 契约只有一份：calls.contract 必须就是服务记录里那份，
            # 否则同一个接口在店里有两个版本，迟早对不上。
            cap_contract = cap.get("contract_path")
            if isinstance(cap_contract, str) and cap_contract:
                check(f"orchestration {name} step {sid} contract matches the service record",
                      calls.get("contract") == cap_contract,
                      f"calls.contract={calls.get('contract')!r} "
                      f"capability.contract_path={cap_contract!r}")

        idset = set(ids)
        for sid, needs in needs_by.items():
            for need in needs:
                check(f"orchestration {name} step {sid} need {need} exists",
                      need in idset, f"needs={sorted(needs)}")

        # 环：Kahn 拓扑排序必须能把所有步骤排完
        indeg = {sid: len(needs_by.get(sid, set()) & idset) for sid in ids}
        ready = [sid for sid in ids if indeg[sid] == 0]
        ordered = 0
        while ready:
            current = ready.pop()
            ordered += 1
            for sid in ids:
                if current in needs_by.get(sid, set()):
                    indeg[sid] -= 1
                    if indeg[sid] == 0:
                        ready.append(sid)
        check(f"orchestration {name} has no cycle", ordered == len(ids),
              f"{ordered}/{len(ids)} 个步骤能拓扑排序 —— 剩下的成环")

        # 孤儿 + 入口唯一
        roots = [sid for sid in ids if not (needs_by.get(sid, set()) & idset)]
        check(f"orchestration {name} has exactly one entry step", len(roots) == 1,
              f"无前置的步骤={roots}")
        # 从入口往下游走（"谁依赖我"），不是往上游走。"needs" 指向上游，
        # 顺着它走只能走到入口自己 —— 第一版就是这么写的，验证器立刻报
        # "从入口到不了：['chart', 'layout', 'upload']"。
        dependents = {sid: set() for sid in ids}
        for sid, needs in needs_by.items():
            for upstream in needs & idset:
                dependents[upstream].add(sid)
        reachable, stack = set(), list(roots)
        while stack:
            current = stack.pop()
            if current in reachable:
                continue
            reachable.add(current)
            stack.extend(dependents[current])
        check(f"orchestration {name} has no orphan step", reachable == idset,
              f"从入口到不了：{sorted(idset - reachable)}")

    base = os.path.join(ROOT, ORCHESTRATION_DIR)
    if os.path.isdir(base):
        for mode in sorted(os.listdir(base)):
            mode_dir = os.path.join(base, mode)
            if mode.startswith(".") or not os.path.isdir(mode_dir):
                continue
            check(f"orchestration mode is declared: {mode}",
                  mode in ORCHESTRATION_MODES,
                  f"unknown mode {mode!r} — declare it in ORCHESTRATION_MODES")
            for target in sorted(os.listdir(mode_dir)):
                target_dir = os.path.join(mode_dir, target)
                if target.startswith(".") or not os.path.isdir(target_dir):
                    continue
                check(f"orchestration ecosystem is declared: {mode}/{target}",
                      target in ORCHESTRATION_ECOSYSTEMS,
                      f"unknown ecosystem {target!r} — declare it in ORCHESTRATION_ECOSYSTEMS")
                for task in sorted(os.listdir(target_dir)):
                    task_dir = os.path.join(target_dir, task)
                    if task.startswith(".") or not os.path.isdir(task_dir):
                        continue
                    rel = f"{ORCHESTRATION_DIR}/{mode}/{target}/{task}"
                    check(f"filesystem orchestration directory is registered: {rel}",
                          rel in declared,
                          "directory exists under orchestrations/ but no registry entry points at it")


def report(exit_code: int) -> int:
    failures = [(name, detail) for name, ok, detail in checks if not ok]
    for name, ok, _ in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    print(f"\n{len(checks)} checks, {len(failures)} failures")
    if failures:
        print("\nFailures:")
        for name, detail in failures:
            print(f"  - {name}: {detail}")
    return 1 if failures else exit_code


if __name__ == "__main__":
    sys.exit(main())
