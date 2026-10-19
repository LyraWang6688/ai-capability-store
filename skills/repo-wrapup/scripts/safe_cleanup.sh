#!/usr/bin/env bash
# repo-wrapup 安全清理：只删除「同时满足三条安全边界」的分支。
#
# 用法：
#   bash scripts/safe_cleanup.sh [repo-path] [base-ref]          # 只出计划（默认，不改动）
#   bash scripts/safe_cleanup.sh [repo-path] [base-ref] --clean  # 真删
#
# 安全边界（三条全中才删）：
#   1. 该分支已推送（无未推送提交）
#   2. 该分支已合并进 BASE
#   3. 该分支不是当前分支，也没有被任何 worktree 占用
#
# worktree 一律不自动删除 —— 只报告。worktree 被别的 agent 占用时误删不可逆。

set -uo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
BASE="${2:-origin/main}"
MODE="${3:-plan}"

cd "$ROOT" || { echo "ERROR=bad repo path" >&2; exit 2; }
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] || { echo "ERROR=not a git repo" >&2; exit 2; }

CURRENT="$(git branch --show-current 2>/dev/null || echo DETACHED)"

# 被 worktree 占用的分支（第二列是 branch；detached 显示 detached）
WT_BRANCHES="$(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')"

# 未推送的分支
UNPUSHED_BRANCHES=""
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/); do
  up="$(git rev-parse --abbrev-ref "$b@{upstream}" 2>/dev/null || true)"
  if [ -n "$up" ]; then
    n="$(git rev-list --count "$up..$b" 2>/dev/null || echo 0)"
    [ "${n:-0}" -gt 0 ] && UNPUSHED_BRANCHES="${UNPUSHED_BRANCHES}${b}"$'\n'
  else
    n="$(git rev-list --count "${BASE}..${b}" 2>/dev/null || echo 0)"
    [ "${n:-0}" -gt 0 ] && UNPUSHED_BRANCHES="${UNPUSHED_BRANCHES}${b}"$'\n'
  fi
done

is_protected() {  # $1=branch
  local b="$1"
  [ "$b" = "$CURRENT" ] && return 0
  [ "$b" = "main" ] || [ "$b" = "master" ] && return 0
  printf '%s\n' "$WT_BRANCHES" | grep -qxF "$b" && return 0
  printf '%s' "$UNPUSHED_BRANCHES" | grep -qxF "$b" && return 0
  return 1
}

# ---------- 候选 ----------
LOCAL_CANDIDATES=""
for b in $(git branch --merged "$BASE" --format='%(refname:short)' 2>/dev/null); do
  is_protected "$b" && continue
  LOCAL_CANDIDATES="${LOCAL_CANDIDATES}${b}"$'\n'
done

REMOTE_CANDIDATES=""
# 注意：%(refname:short) 会把 origin/HEAD 截成裸 "origin"，必须用 lstrip=3
for b in $(git branch -r --merged "$BASE" --format='%(refname:lstrip=3)' 2>/dev/null); do
  case "$b" in HEAD|main|master|origin) continue ;; esac
  REMOTE_CANDIDATES="${REMOTE_CANDIDATES}${b}"$'\n'
done

echo "REPO=$ROOT"
echo "BASE=$BASE"
echo "MODE=$MODE"
echo "PROTECTED_CURRENT=$CURRENT"
echo
echo "--- 可安全删除 · 本地分支 ---"
printf '%s' "$LOCAL_CANDIDATES" | grep -c . >/dev/null 2>&1
printf '%s' "$LOCAL_CANDIDATES" | sed '/^$/d; s/^/  /'
echo "--- 可安全删除 · 远端分支 ---"
printf '%s' "$REMOTE_CANDIDATES" | sed '/^$/d; s/^/  /'
echo

# 被跳过的（有风险）
RISKY="$(printf '%s\n%s\n' "$LOCAL_CANDIDATES" "$REMOTE_CANDIDATES" >/dev/null; true)"
if printf '%s' "$UNPUSHED_BRANCHES" | grep -q .; then
  echo "--- ⚠ 含未推送提交 · 不删（需人工确认）---"
  printf '%s' "$UNPUSHED_BRANCHES" | sed '/^$/d; s/^/  /'
  echo
fi

if [ "$MODE" != "--clean" ]; then
  echo "PLAN_ONLY=yes"
  echo "提示：加 --clean 才会真正删除。"
  exit 0
fi

# ---------- 执行 ----------
echo "=== 开始清理 ==="
DELETED_LOCAL=0
while IFS= read -r b; do
  [ -z "$b" ] && continue
  if git branch -D "$b" >/dev/null 2>&1; then
    echo "  deleted local: $b"; DELETED_LOCAL=$((DELETED_LOCAL+1))
  else
    echo "  FAILED local: $b"
  fi
done <<< "$LOCAL_CANDIDATES"

DELETED_REMOTE=0
while IFS= read -r b; do
  [ -z "$b" ] && continue
  if git push origin --delete "$b" >/dev/null 2>&1; then
    echo "  deleted remote: $b"; DELETED_REMOTE=$((DELETED_REMOTE+1))
  else
    echo "  FAILED remote: $b"
  fi
done <<< "$REMOTE_CANDIDATES"

echo
echo "DELETED_LOCAL=$DELETED_LOCAL"
echo "DELETED_REMOTE=$DELETED_REMOTE"
echo
echo "=== 清理后复核（请再跑一次 audit_cleanliness.sh）==="
