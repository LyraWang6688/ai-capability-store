#!/usr/bin/env bash
# Deterministic offline tests for the store-publish scripts.
# No network, no writes to the real Store: everything runs against a fixture.
set -euo pipefail

# Keep the skill directory clean: importing store_root would otherwise drop a
# __pycache__/ next to the scripts.
export PYTHONDONTWRITEBYTECODE=1

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# $TMPDIR on macOS carries a trailing slash; strip it so path comparisons match.
tmpbase="${TMPDIR:-/tmp}"
tmpbase="${tmpbase%/}"
fixture=$(mktemp -d "$tmpbase/store-publish-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT

store="$fixture/store"
mkdir -p "$store/skills" "$store/external-capabilities" "$store/dependencies"

cat > "$store/registry.yaml" <<'YAML'
schema_version: 2
store:
  name: ai-capability-store
  owner: tester
registries:
  skills: skills/registry.yaml
  external_capabilities: external-capabilities/registry.yaml
  dependencies: dependencies/capability-map.yaml
YAML

cat > "$store/skills/registry.yaml" <<'YAML'
schema_version: 2
skills:
  demo-skill:
    name: demo-skill
    path: skills/demo-skill
    scope: shared
    status: testing
    version: 0.1.0
    updated: "2026-10-03"
YAML

cat > "$store/external-capabilities/registry.yaml" <<'YAML'
schema_version: 1
capabilities:
  demo-mcp:
    name: demo-mcp
    provider: tester
    type: mcp
    status: limited
    version: 0.1.0
    implementation_path: external-capabilities/mcp/demo-mcp
    provider_path: external-capabilities/providers/tester/README.md
YAML

cat > "$store/dependencies/capability-map.yaml" <<'YAML'
schema_version: 1
dependencies: []
YAML

pass=0
fail=0
expect() {  # expect <wanted-exit> <label> <command...>
  local want=$1 label=$2; shift 2
  local got=0
  "$@" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "  ok   $label (exit $got)"; pass=$((pass + 1))
  else
    echo "  FAIL $label: wanted exit $want, got $got" >&2; fail=$((fail + 1))
  fi
}

export AI_CAPABILITY_STORE="$store"

# Pick an interpreter that actually has PyYAML. Defaulting to `python3` made
# this suite report 13 bogus failures on a machine whose system Python lacks it
# — every script would exit 3 — which is worse than failing, because it looks
# like the scripts are broken. Prefer $PYTHON, then the Store's own .venv
# (SKILL.md "环境准备" creates it), then give up with an explanation.
if [[ -n "${PYTHON:-}" ]]; then
  PY="$PYTHON"
else
  # -u AI_CAPABILITY_STORE: it is already exported as the fixture above, and the
  # probe must find the REAL Store (the one that owns .venv), not the fixture.
  real_store=$(env -u AI_CAPABILITY_STORE python3 "$script_dir/store_root.py" 2>/dev/null || true)
  if [[ -n "$real_store" && -x "$real_store/.venv/bin/python" ]]; then
    PY="$real_store/.venv/bin/python"
  else
    PY=python3
  fi
fi

if ! "$PY" -c 'import yaml' >/dev/null 2>&1; then
  echo "ERROR: $PY has no PyYAML." >&2
  echo "Create the Store venv (see SKILL.md 环境准备) or pass PYTHON=<interpreter>." >&2
  exit 2
fi
echo "interpreter: $PY"

echo "store_root.py"
expect 0 "locates the Store from \$AI_CAPABILITY_STORE" \
  "$PY" "$script_dir/store_root.py"
resolved=$("$PY" "$script_dir/store_root.py")
if [[ "$resolved" == "$store" ]]; then
  echo "  ok   resolved the expected path"; pass=$((pass + 1))
else
  echo "  FAIL resolved '$resolved', expected '$store'" >&2; fail=$((fail + 1))
fi

echo "reuse_scan.py"
expect 10 "flags an already-registered skill" "$PY" "$script_dir/reuse_scan.py" demo-skill
expect 10 "flags an already-registered capability" "$PY" "$script_dir/reuse_scan.py" demo-mcp
expect 0  "passes a brand-new name" "$PY" "$script_dir/reuse_scan.py" brand-new-thing
expect 10 "mixed batch fails if any name exists" \
  "$PY" "$script_dir/reuse_scan.py" brand-new-thing demo-skill
expect 0  "--all lists a populated registry" "$PY" "$script_dir/reuse_scan.py" --all
expect 2  "refuses to run with no arguments" "$PY" "$script_dir/reuse_scan.py"

echo "reuse_scan.py — unreadable Store"
broken="$fixture/broken"
mkdir -p "$broken/skills" "$broken/external-capabilities" "$broken/dependencies"
printf 'schema_version: 2\n' > "$broken/registry.yaml"
printf 'schema_version: 2\n' > "$broken/skills/registry.yaml"
printf 'schema_version: 1\n' > "$broken/external-capabilities/registry.yaml"
printf 'schema_version: 1\n' > "$broken/dependencies/capability-map.yaml"
AI_CAPABILITY_STORE="$broken" "$PY" "$script_dir/reuse_scan.py" anything >/dev/null 2>&1 \
  && { echo "  FAIL a router with no 'registries' mapping was accepted" >&2; fail=$((fail + 1)); } \
  || { echo "  ok   rejects a router with no 'registries' mapping"; pass=$((pass + 1)); }

echo "check_tag_version.py"
# A separate git fixture: this script asks git questions, so the plain fixture
# directory above is not enough.
gitsrc="$fixture/gitstore"
cp -R "$store" "$gitsrc"
(
  cd "$gitsrc"
  git init -q
  git config user.email tester@example.com
  git config user.name Tester
  git checkout -q -b main
  git add -A
  git commit -q -m "registries at 0.1.0"

  # consistent: tag points at a commit whose registry already says 0.1.0
  git tag -a demo-mcp-v0.1.0 -m "demo-mcp v0.1.0"

  # drift: a tag created BEFORE the registry caught up — the exact failure this
  # script exists to catch, and the shape of the four real occurrences.
  git tag -a demo-skill-v0.9.9 -m "claims 0.9.9, registry says 0.1.0"

  # a commit that exists but is NOT on main, for the reachability check
  git checkout -q -b side
  git commit -q --allow-empty -m "unmerged work"
  side_sha=$(git rev-parse HEAD)
  git checkout -q main
  echo "$side_sha" > "$gitsrc/../side_sha"
) >/dev/null 2>&1
side_sha=$(cat "$fixture/side_sha")

export AI_CAPABILITY_STORE="$gitsrc"
expect 0  "passes a version the registry already carries" \
  "$PY" "$script_dir/check_tag_version.py" demo-skill 0.1.0 main
expect 10 "refuses a version the registry does not carry" \
  "$PY" "$script_dir/check_tag_version.py" demo-skill 0.1.1 main
expect 10 "refuses to reuse an existing tag name" \
  "$PY" "$script_dir/check_tag_version.py" demo-mcp 0.1.0 main
expect 10 "refuses an unregistered asset" \
  "$PY" "$script_dir/check_tag_version.py" no-such-asset 0.1.0 main
expect 2  "refuses to run with too few arguments" \
  "$PY" "$script_dir/check_tag_version.py" demo-skill
expect 10 "audit reports drift" \
  "$PY" "$script_dir/check_tag_version.py" --audit
expect 10 "rejects a commit that is not on main" \
  "$PY" "$script_dir/check_tag_version.py" demo-skill 0.1.0 "$side_sha"
export AI_CAPABILITY_STORE="$store"

echo
if ((fail > 0)); then
  echo "FAIL: $fail of $((pass + fail)) checks failed" >&2
  exit 1
fi
echo "PASS: store-publish script tests ($pass checks)"
