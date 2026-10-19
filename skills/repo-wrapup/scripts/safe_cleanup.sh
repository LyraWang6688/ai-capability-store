#!/usr/bin/env bash
# repo-wrapup 安全清理：只删除「已确认可删」的分支。
#
# 用法：
#   bash scripts/safe_cleanup.sh [repo-path] [base-ref]             # 只出计划（默认）
#   bash scripts/safe_cleanup.sh [repo-path] [base-ref] --clean     # 真删
#
# ⚠️ 「已合并」用双判据（2026-10-19 由 review 修正）：
#     ① base 的祖先  或  ② 对应 PR 状态为 MERGED
#   因为 `git branch --merged` 看不见 squash 合并——而本仓库主要用 squash。
#
# 安全边界（全中才删）：
#   1. 已合并（双判据）
#   2. 无未推送提交
#   3. 无 open PR
#   4. 不是当前分支 / main / master
#   5. 没有被任何 worktree 占用
#
# 判不了的（既没合并、也没未推送、也没 open PR）→ 计入 UNKNOWN，**只报告不删**。
# worktree 一律不自动删除（可能被其他 agent 占用，移除不可逆）。

set -uo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
BASE="${2:-origin/main}"
MODE="${3:-plan}"

cd "$ROOT" || { echo "ERROR=bad repo path" >&2; exit 2; }
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = "true" ] || { echo "ERROR=not a git repo" >&2; exit 2; }

CURRENT="$(git branch --show-current 2>/dev/null || echo DETACHED)"

# PR 状态表（1 次 API 调用）
HAVE_GH=no; PR_MAP=""
if command -v gh >/dev/null 2>&1 && gh repo view >/dev/null 2>&1; then
  HAVE_GH=yes
  PR_MAP="$(gh pr list --state all --limit 500 --json headRefName,state 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d=[]
for p in d: print(p.get("headRefName",""), p.get("state",""))
' 2>/dev/null || true)"
fi
pr_state() { printf '%s\n' "$PR_MAP" | awk -v b="$1" '$1==b {print $2; exit}'; }

WT_BRANCHES="$(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')"

classify() {  # $1=branch → MERGED | UNPUSHED | OPEN_PR | UNKNOWN | PROTECTED
  local b="$1"
  case "$b" in main|master) echo PROTECTED; return ;; esac
  [ "$b" = "$CURRENT" ] && { echo PROTECTED; return; }
  printf '%s\n' "$WT_BRANCHES" | grep -qxF "$b" && { echo PROTECTED; return; }

  local up n
  up="$(git rev-parse --abbrev-ref "$b@{upstream}" 2>/dev/null || true)"
  if [ -n "$up" ]; then
    n="$(git rev-list --count "$up..$b" 2>/dev/null || echo 0)"
  else
    n="$(git rev-list --count "${BASE}..${b}" 2>/dev/null || echo 0)"
  fi
  [ "${n:-0}" -gt 0 ] && { echo UNPUSHED; return; }

  local st anc
  st="$(pr_state "$b")"
  [ "$st" = "OPEN" ] && { echo OPEN_PR; return; }
  anc=no
  git merge-base --is-ancestor "$b" "$BASE" 2>/dev/null && anc=yes
  if [ "$anc" = yes ] || [ "$st" = "MERGED" ]; then echo MERGED; return; fi
  echo UNKNOWN
}

LOCAL_CANDIDATES=""; UNKNOWN_LIST=""; UNPUSHED_LIST=""; OPENPR_LIST=""
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null); do
  case "$(classify "$b")" in
    MERGED)    LOCAL_CANDIDATES="${LOCAL_CANDIDATES}${b}"$'\n' ;;
    UNKNOWN)   UNKNOWN_LIST="${UNKNOWN_LIST}${b}"$'\n' ;;
    UNPUSHED)  UNPUSHED_LIST="${UNPUSHED_LIST}${b}"$'\n' ;;
    OPENPR)    OPENPR_LIST="${OPENPR_LIST}${b}"$'\n' ;;
  esac
done

REMOTE_CANDIDATES=""
for b in $(git branch -r --format='%(refname:lstrip=3)' 2>/dev/null); do
  case "$b" in HEAD|main|master|origin) continue ;; esac
  anc=no; git merge-base --is-ancestor "origin/$b" "$BASE" 2>/dev/null && anc=yes
  st="$(pr_state "$b")"
  [ "$st" = "OPEN" ] && continue          # 有 open PR，绝不能删
  if [ "$anc" = yes ] || [ "$st" = "MERGED" ]; then
    REMOTE_CANDIDATES="${REMOTE_CANDIDATES}${b}"$'\n'
  fi
done

echo "REPO=$ROOT"; echo "BASE=$BASE"; echo "MODE=$MODE"; echo "GH_AVAILABLE=$HAVE_GH"
echo
echo "--- 可安全删除 · 本地 ---"; printf '%s' "$LOCAL_CANDIDATES" | sed '/^$/d; s/^/  /'
echo "--- 可安全删除 · 远端 ---"; printf '%s' "$REMOTE_CANDIDATES" | sed '/^$/d; s/^/  /'
echo
echo "--- 不删 · 含未推送提交 ---"; printf '%s' "$UNPUSHED_LIST" | sed '/^$/d; s/^/  /'
echo "--- 不删 · 有 open PR ---"; printf '%s' "$OPENPR_LIST" | sed '/^$/d; s/^/  /'
echo "--- ⚠ 判不了（UNKNOWN）· 只报告不删 ---"; printf '%s' "$UNKNOWN_LIST" | sed '/^$/d; s/^/  /'
UNKNOWN_N="$(printf '%s' "$UNKNOWN_LIST" | grep -c . || true)"
echo
if [ "$HAVE_GH" = no ]; then
  echo "⚠ 无 gh 可用：squash 合并无法识别，未识别分支已计入 UNKNOWN。"
fi
echo "UNKNOWN_COUNT=$UNKNOWN_N"

if [ "$MODE" != "--clean" ]; then
  echo "PLAN_ONLY=yes"; echo "提示：加 --clean 才会真正删除。"; exit 0
fi

echo; echo "=== 开始清理 ==="
DL=0; DR=0
while IFS= read -r b; do
  [ -z "$b" ] && continue
  if git branch -D "$b" >/dev/null 2>&1; then echo "  deleted local: $b"; DL=$((DL+1)); else echo "  FAILED local: $b"; fi
done <<< "$LOCAL_CANDIDATES"
while IFS= read -r b; do
  [ -z "$b" ] && continue
  if git push origin --delete "$b" >/dev/null 2>&1; then echo "  deleted remote: $b"; DR=$((DR+1)); else echo "  FAILED remote: $b"; fi
done <<< "$REMOTE_CANDIDATES"

echo; echo "DELETED_LOCAL=$DL"; echo "DELETED_REMOTE=$DR"
[ "$UNKNOWN_N" -gt 0 ] && echo "⚠ 仍有 $UNKNOWN_N 个 UNKNOWN 分支未处理——需要人工判断。"
echo "=== 请复跑 audit_cleanliness.sh 复核 ==="
