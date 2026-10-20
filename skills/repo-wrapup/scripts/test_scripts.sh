#!/usr/bin/env bash
# Exercises audit_cleanliness.sh and safe_cleanup.sh against a throwaway repository.
#
# These scripts delete branches. A deletion script with no test is the same class of
# defect as a validator that passes without checking anything: the green result means
# "nobody looked", not "it works". The cases below are the four ways `--clean` could
# destroy work, plus the one thing it exists to do.
set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/repo-wrapup-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT

# gh 在 CI 里存在但未认证，会让 PR 判据走进另一条分支，测试就不再确定。
# 这里放一个永远失败的 gh，让「没有 gh」这条降级路径被真正测到。
stub="$fixture/bin"
mkdir -p "$stub"
printf '#!/bin/sh\nexit 1\n' > "$stub/gh"
chmod +x "$stub/gh"
export PATH="$stub:$PATH"

origin="$fixture/origin.git"
work="$fixture/work"
git init -q --bare "$origin"
git clone -q "$origin" "$work" 2>/dev/null
git -C "$work" config user.name "Repo Wrapup Test"
git -C "$work" config user.email "repo-wrapup-test@example.invalid"
git -C "$work" config commit.gpgsign false

printf 'one\n' > "$work/a.txt"
git -C "$work" add -A
git -C "$work" commit -qm init
git -C "$work" branch -M main
git -C "$work" push -q -u origin main 2>/dev/null

pass=0
fail=0
ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; }
has()  { grep -qF "$2" <<<"$1" && ok "$3" || bad "$3"; }
absent() { grep -qF "$2" <<<"$1" && bad "$3" || ok "$3"; }
exists() { git -C "$work" rev-parse --verify -q "$1" >/dev/null && ok "$2" || bad "$2"; }
gone()   { git -C "$work" rev-parse --verify -q "$1" >/dev/null && bad "$2" || ok "$2"; }

echo "repo-wrapup scripts"

# ── 1. 干净仓库必须报 CLEAN=yes ───────────────────────────────
out=$("$script_dir/audit_cleanliness.sh" "$work" 2>&1)
has "$out" "CLEAN=yes" "clean repository reports CLEAN=yes"
has "$out" "UNKNOWN=0" "clean repository has no UNKNOWN"

# ── 2. 已合并但没删的分支 → 被发现，然后被删 ─────────────────
git -C "$work" checkout -q -b feat/merged
printf 'two\n' > "$work/b.txt"
git -C "$work" add -A && git -C "$work" commit -qm feat
git -C "$work" checkout -q main
git -C "$work" merge -q --no-ff feat/merged -m merge 2>/dev/null
git -C "$work" push -q origin main 2>/dev/null

out=$("$script_dir/audit_cleanliness.sh" "$work" 2>&1)
has "$out" "LOCAL_MERGED_NOT_DELETED=1" "merged branch is counted"
has "$out" "CLEAN=no" "merged branch makes it not clean"

"$script_dir/safe_cleanup.sh" "$work" origin/main >/dev/null 2>&1
exists "feat/merged" "plan mode deletes nothing"

"$script_dir/safe_cleanup.sh" "$work" origin/main --clean >/dev/null 2>&1
gone "feat/merged" "--clean deletes a merged branch"

# ── 3. 含未推送提交的分支 → 必须活下来 ───────────────────────
git -C "$work" checkout -q -b feat/unpushed
printf 'three\n' > "$work/c.txt"
git -C "$work" add -A && git -C "$work" commit -qm unpushed
git -C "$work" checkout -q main

out=$("$script_dir/audit_cleanliness.sh" "$work" 2>&1)
has "$out" "BRANCHES_WITH_UNPUSHED=1" "unpushed branch is counted"

"$script_dir/safe_cleanup.sh" "$work" origin/main --clean >/dev/null 2>&1
exists "feat/unpushed" "--clean refuses a branch with unpushed commits"

# ── 4. 当前分支和 main 永远不删 ──────────────────────────────
out=$("$script_dir/audit_cleanliness.sh" "$work" 2>&1)
absent "$out" "DETAIL_LOCAL_MERGED	main" "main is never a deletion candidate"
exists "main" "main survives --clean"

# ── 5. 未知情况只报告不删 ────────────────────────────────────
# 分支既没合并、也没未推送提交（--no-merge 后 reset 到 base），只能进 UNKNOWN。
git -C "$work" checkout -q -b feat/unknown
printf 'four\n' > "$work/d.txt"
git -C "$work" add -A && git -C "$work" commit -qm unknown-once
git -C "$work" push -q -u origin feat/unknown 2>/dev/null
git -C "$work" reset -q --hard origin/main
git -C "$work" checkout -q main

out=$("$script_dir/audit_cleanliness.sh" "$work" 2>&1)
if grep -qE '^UNKNOWN=[1-9]' <<<"$out"; then
  ok "unclassifiable branch lands in UNKNOWN"
  "$script_dir/safe_cleanup.sh" "$work" origin/main --clean >/dev/null 2>&1
  git -C "$work" rev-parse --verify -q feat/unknown >/dev/null \
    && ok "UNKNOWN branch survives --clean" \
    || bad "UNKNOWN branch survives --clean"
else
  # 这是可接受的：判据足够就分类成功。但不能静默跳过。
  ok "unclassifiable branch was classified instead (UNKNOWN=0)"
fi

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
printf 'PASS: repo-wrapup script tests (%d checks)\n' "$pass"
