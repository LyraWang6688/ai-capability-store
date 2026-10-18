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
        provider_path/implementation_path/version), type/status enums,
        map key == name, provider kebab-case, provider_path location and exists
    8b. Store-managed contract: implementation_path is REQUIRED (this Store
        accepts Store-managed capabilities only), the path must exist, must be
        relative with no ../, and must live under external-capabilities/;
        version must be a valid semantic version
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
ALLOWED_CAPABILITY_STATUSES = {"available", "limited", "disabled", "unknown"}
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
ALLOWED_TRIGGER_KINDS = {"daily", "weekly", "monthly", "manual", "event"}
# WHO runs it. The Automation Domain originally assumed GitHub Actions only, so
# `workflow` was unconditionally required; that made a launchd-driven job
# unrepresentable. Executor is a separate axis from trigger_kind:
#   trigger_kind = how often      executor = what runs it
ALLOWED_EXECUTORS = {"github-actions", "launchd", "human"}
# WHERE the output lands. A `git-branch` target writes machine output to a branch
# that never merges (the data branch); an `external-system` target writes into
# something we do not own (e.g. a Feishu Base) and cannot be validated here.
ALLOWED_OUTPUT_TARGETS = {"git-branch", "external-system"}
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
        # Required fields. `implementation_path` and `version` are required
        # because this Store accepts Store-managed capabilities ONLY (see
        # external-capabilities/README.md). They used to be optional, which made
        # every implementation check below conditional -- an entry that omitted
        # implementation_path skipped all of them and still reported a clean
        # run, while pointing at no code. Absent is now an error.
        for field in ("name", "provider", "type", "status", "provider_path",
                      "implementation_path", "version"):
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
        # Store-managed contract: implementation_path is REQUIRED (declared
        # above), so here the path must be relative, live under
        # external-capabilities/, and actually exist. Previously this whole
        # block was guarded by `if impl is not None`, so omitting the field
        # silently skipped every line of it.
        impl = entry.get("implementation_path")
        if isinstance(impl, str) and impl:
            iparts = impl.split("/")
            check(f"capability {key} implementation_path relative",
                  not os.path.isabs(impl) and ".." not in iparts, impl)
            check(f"capability {key} implementation_path under external-capabilities/",
                  impl.startswith("external-capabilities/"), impl)
            check(f"capability {key} implementation_path exists",
                  os.path.isdir(os.path.join(ROOT, impl)), impl)
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
    if executor == "github-actions":
        return bool(has_workflow) and not has_launchd
    if executor == "launchd":
        return bool(has_launchd) and not has_workflow
    if executor == "human":
        return not has_workflow and not has_launchd
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
                if trigger != "manual":
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
    expected_domains = ("skills", "external_capabilities", "dependencies", "automations")
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
        check("automation registry keeps 5 trigger kinds",
              allowed_trigger == ALLOWED_TRIGGER_KINDS, f"kinds={sorted(allowed_trigger)}")
        allowed_execs = set(autos_reg.get("allowed_executors") or [])
        check("automation registry keeps 3 executors",
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
        check("capability registry keeps 4 statuses", allowed_statuses == ALLOWED_CAPABILITY_STATUSES,
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
                    if not os.path.isdir(os.path.join(full, child)):
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

    return report(0)


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
