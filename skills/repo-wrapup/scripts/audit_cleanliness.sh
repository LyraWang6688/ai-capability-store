#!/usr/bin/env bash
# repo-wrapup 体检：输出「工作区干净度」的可核验指标。
# 只读，不修改任何东西。
#
# 用法：
#   bash scripts/audit_cleanliness.sh [repo-path] [base-ref]
#   默认 base-ref = origin/main
#
# 输出：KEY=VALUE 供机器读；DETAIL 行供人读。

set -uo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "${ROOT:-}" ] || [ ! -d "$ROOT/.git" ] && [ ! -f "$ROOT/.git" ]; then
  echo "ERROR=not a git repository" >&2
  exit 2
fi
cd "$ROOT" || exit 2

BASE="${2:-origin/main}"
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then BASE=origin/main
  elif git rev-parse --verify --quiet origin/master >/dev/null; then BASE=origin/master
  else BASE=""; fi
fi

CURRENT="$(git branch --show-current 2>/dev/null || echo DETACHED)"

# ---------- 1. worktree ----------
WT_ALL="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')"
WT_COUNT="$(printf '%s\n' "$WT_ALL" | grep -c . || true)"
EXTRA_WT=$(( WT_COUNT > 0 ? WT_COUNT - 1 : 0 ))

# ---------- 2. 本地已合并未删 ----------
if [ -n "$BASE" ]; then
  LOCAL_MERGED="$(git branch --merged "$BASE" --format='%(refname:short)' 2>/dev/null \
    | grep -vxE "$CURRENT|main|master" || true)"
else
  LOCAL_MERGED=""
fi
LOCAL_MERGED_N="$(printf '%s\n' "$LOCAL_MERGED" | grep -c . || true)"

# ---------- 3. 远端已合并未删 ----------
if [ -n "$BASE" ]; then
  # 注意：%(refname:short) 会把 origin/HEAD 截成裸 "origin"，必须用 lstrip=3
  REMOTE_MERGED="$(git branch -r --merged "$BASE" --format='%(refname:lstrip=3)' 2>/dev/null \
    | grep -vxE 'HEAD|main|master|origin' || true)"
else
  REMOTE_MERGED=""
fi
REMOTE_MERGED_N="$(printf '%s\n' "$REMOTE_MERGED" | grep -c . || true)"

# ---------- 4. 未推送提交 ----------
UNPUSHED=""
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null); do
  up="$(git rev-parse --abbrev-ref "$b@{upstream}" 2>/dev/null || true)"
  if [ -n "$up" ]; then
    n="$(git rev-list --count "$up..$b" 2>/dev/null || echo 0)"
    [ "${n:-0}" -gt 0 ] && UNPUSHED="${UNPUSHED}${b} (ahead ${n})"$'\n'
  else
    # 无上游：相对 BASE 有提交就算风险
    if [ -n "$BASE" ]; then
      n="$(git rev-list --count "${BASE}..${b}" 2>/dev/null || echo 0)"
      [ "${n:-0}" -gt 0 ] && UNPUSHED="${UNPUSHED}${b} (no upstream, ahead ${n})"$'\n'
    fi
  fi
done
UNPUSHED_N="$(printf '%s' "$UNPUSHED" | grep -c . || true)"

# ---------- 5. 未关闭 PR ----------
OPEN_PRS="?"
OPEN_PR_N="?"
if command -v gh >/dev/null 2>&1 && gh repo view >/dev/null 2>&1; then
  OPEN_PR_N="$(gh pr list --state open --json number --jq 'length' 2>/dev/null || echo '?')"
  OPEN_PRS="$(gh pr list --state open --limit 50 --json number,headRefName --jq '.[] | "#\(.number) \(.headRefName)"' 2>/dev/null || true)"
fi

# ---------- 6. 未提交改动 ----------
DIRTY="$(git status --porcelain 2>/dev/null || true)"
DIRTY_N="$(printf '%s\n' "$DIRTY" | grep -c . || true)"

# ---------- 汇总 ----------
CLEAN=yes
[ "$EXTRA_WT" -gt 0 ] && CLEAN=no
[ "$LOCAL_MERGED_N" -gt 0 ] && CLEAN=no
[ "$REMOTE_MERGED_N" -gt 0 ] && CLEAN=no
[ "$UNPUSHED_N" -gt 0 ] && CLEAN=no
[ "$DIRTY_N" -gt 0 ] && CLEAN=no

echo "REPO=$ROOT"
echo "BASE=${BASE:-<none>}"
echo "CURRENT_BRANCH=$CURRENT"
echo "EXTRA_WORKTREES=$EXTRA_WT"
echo "LOCAL_MERGED_NOT_DELETED=$LOCAL_MERGED_N"
echo "REMOTE_MERGED_NOT_DELETED=$REMOTE_MERGED_N"
echo "BRANCHES_WITH_UNPUSHED=$UNPUSHED_N"
echo "OPEN_PRS=$OPEN_PR_N"
echo "UNCOMMITTED_CHANGES=$DIRTY_N"
echo "CLEAN=$CLEAN"

# ---------- 明细 ----------
[ -n "$LOCAL_MERGED" ] && printf '%s\n' "$LOCAL_MERGED" | sed 's/^/DETAIL_LOCAL_MERGED\t/'
[ -n "$REMOTE_MERGED" ] && printf '%s\n' "$REMOTE_MERGED" | sed 's/^/DETAIL_REMOTE_MERGED\t/'
[ -n "$UNPUSHED" ] && printf '%s' "$UNPUSHED" | sed 's/^/DETAIL_UNPUSHED\t/'
[ -n "$OPEN_PRS" ] && printf '%s\n' "$OPEN_PRS" | sed 's/^/DETAIL_OPEN_PR\t/'
if [ "$EXTRA_WT" -gt 0 ]; then
  printf '%s\n' "$WT_ALL" | tail -n +2 | sed 's/^/DETAIL_EXTRA_WORKTREE\t/'
fi

exit 0
