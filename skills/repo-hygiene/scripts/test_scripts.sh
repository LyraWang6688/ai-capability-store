#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/repo-hygiene-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT

repo="$fixture/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.name "Repo Hygiene Test"
git -C "$repo" config user.email "repo-hygiene-test@example.invalid"

printf 'cache/\n.local/\n' > "$repo/.gitignore"
printf 'tracked\n' > "$repo/tracked.txt"
git -C "$repo" add .gitignore tracked.txt
git -C "$repo" commit -qm "test fixture"

mkdir -p "$repo/cache" "$repo/.local/reports"
printf 'generated\n' > "$repo/cache/output.bin"
printf 'protected\n' > "$repo/.local/reports/report.csv"
printf 'valuable untracked\n' > "$repo/notes.txt"

audit_output=$("$script_dir/audit_git_state.sh" --repo "$repo" -- tracked.txt cache notes.txt)
grep -F $'PATH\ttracked.txt\texists=yes\ttype=file\ttracked=yes\tignored=no\tchanged=no' <<<"$audit_output" >/dev/null
grep -F $'PATH\tcache\texists=yes\ttype=directory\ttracked=no\tignored=yes' <<<"$audit_output" >/dev/null

"$script_dir/safe_delete_guard.sh" --repo "$repo" -- cache >/dev/null

if "$script_dir/safe_delete_guard.sh" --repo "$repo" -- tracked.txt >/dev/null 2>&1; then
  echo "FAIL: tracked path passed deletion guard" >&2
  exit 1
fi
if "$script_dir/safe_delete_guard.sh" --repo "$repo" -- notes.txt >/dev/null 2>&1; then
  echo "FAIL: visible untracked path passed deletion guard" >&2
  exit 1
fi
# A path that is ignored but named by tracked content must not pass silently.
# This is the `.venv` case: gitignored, load-bearing, referenced by a tracked script.
printf '.venv/\n' >> "$repo/.gitignore"
printf '#!/bin/sh\n.venv/bin/python3 -c pass\n' > "$repo/run.sh"
git -C "$repo" add .gitignore run.sh
git -C "$repo" commit -qm "reference .venv from tracked content"
mkdir -p "$repo/.venv/bin"
printf 'x\n' > "$repo/.venv/bin/python3"
if "$script_dir/safe_delete_guard.sh" --repo "$repo" -- .venv >/dev/null 2>&1; then
  echo "FAIL: ignored-but-referenced path passed deletion guard" >&2
  exit 1
fi

if "$script_dir/safe_delete_guard.sh" --repo "$repo" -- .git >/dev/null 2>&1; then
  echo "FAIL: .git passed deletion guard" >&2
  exit 1
fi

"$script_dir/verify_cleanup.sh" --repo "$repo" \
  --present .local/reports/report.csv \
  --ignored .local/reports/report.csv >/dev/null

rm -rf -- "$repo/cache"
"$script_dir/verify_cleanup.sh" --repo "$repo" \
  --absent cache \
  --present .local/reports/report.csv \
  --ignored .local/reports/report.csv >/dev/null

if "$script_dir/verify_cleanup.sh" --repo "$repo" --absent tracked.txt >/dev/null 2>&1; then
  echo "FAIL: verifier accepted an existing path as absent" >&2
  exit 1
fi

echo "PASS: repo-hygiene script tests"
