#!/usr/bin/env bash
# repo-wrapup 体检：输出「工作区干净度」的可核验指标。只读，不修改任何东西。
#
# 用法：bash scripts/audit_cleanliness.sh [repo-path] [base-ref]
#
# ⚠️ 关键设计（2026-10-19 由 review 修正）：
#   `git branch --merged` **看不见 squash 合并**——squash 重写了提交，
#   分支 HEAD 不再是 base 的祖先。本仓库主要用 squash 合并，只看 --merged
#   会系统性漏报，且漏报的表现是「报告说干净」。
#   因此「已合并」用双判据：
#     ① base 的祖先  或  ② 对应 PR 状态为 MERGED
#   并且：判不了的必须计入 UNKNOWN 并列出 —— **沉默的零 ≠ 确认的零**。
#
# 输出：KEY=VALUE 供机器读；DETAIL_* 行供人读。

set -uo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
if [ -z "${ROOT:-}" ] || { [ ! -d "$ROOT/.git" ] && [ ! -f "$ROOT/.git" ]; }; then
  echo "ERROR=not a git repository" >&2; exit 2
fi
cd "$ROOT" || exit 2

BASE="${2:-origin/main}"
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  if git rev-parse --verify --quiet origin/main >/dev/null; then BASE=origin/main
  elif git rev-parse --verify --quiet origin/master >/dev/null; then BASE=origin/master
  else BASE=""; fi
fi

CURRENT="$(git branch --show-current 2>/dev/null || echo DETACHED)"

# ---------- PR 状态表（1 次 API 调用）----------
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

# ---------- worktree ----------
WT_ALL="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')"
WT_COUNT="$(printf '%s\n' "$WT_ALL" | grep -c . || true)"
EXTRA_WT=$(( WT_COUNT > 0 ? WT_COUNT - 1 : 0 ))

# ---------- 本地分支分类 ----------
LOCAL_MERGED=""; UNKNOWN=""; UNPUSHED=""
for b in $(git for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null); do
  case "$b" in main|master) continue ;; esac
  [ "$b" = "$CURRENT" ] && continue

  anc=no
  [ -n "$BASE" ] && git merge-base --is-ancestor "$b" "$BASE" 2>/dev/null && anc=yes
  st="$(pr_state "$b")"
  prm=no; pro=no
  [ "$st" = "MERGED" ] && prm=yes
  [ "$st" = "OPEN" ] && pro=yes

  up="$(git rev-parse --abbrev-ref "$b@{upstream}" 2>/dev/null || true)"
  if [ -n "$up" ]; then
    n="$(git rev-list --count "$up..$b" 2>/dev/null || echo 0)"
  elif [ -n "$BASE" ]; then
    n="$(git rev-list --count "${BASE}..${b}" 2>/dev/null || echo 0)"
  else
    n=0
  fi

  if [ "${n:-0}" -gt 0 ]; then
    UNPUSHED="${UNPUSHED}${b} (ahead ${n})"$'\n'
  elif [ "$pro" = yes ]; then
    : # 有 open PR，正常在等合
  elif [ "$anc" = yes ] || [ "$prm" = yes ]; then
    how="ancestor"; [ "$anc" = no ] && how="PR-merged(squash)"
    LOCAL_MERGED="${LOCAL_MERGED}${b}  [${how}]"$'\n'
  else
    UNKNOWN="${UNKNOWN}${b}"$'\n'   # 判不了，必须报出来
  fi
done
LOCAL_MERGED_N="$(printf '%s' "$LOCAL_MERGED" | grep -c . || true)"
UNPUSHED_N="$(printf '%s' "$UNPUSHED" | grep -c . || true)"
UNKNOWN_N="$(printf '%s' "$UNKNOWN" | grep -c . || true)"

# ---------- 远端已合并未删 ----------
REMOTE_MERGED=""
if [ -n "$BASE" ]; then
  for b in $(git branch -r --format='%(refname:lstrip=3)' 2>/dev/null); do
    case "$b" in HEAD|main|master|origin) continue ;; esac
    anc=no
    git merge-base --is-ancestor "origin/$b" "$BASE" 2>/dev/null && anc=yes
    st="$(pr_state "$b")"
    if [ "$anc" = yes ] || [ "$st" = "MERGED" ]; then
      REMOTE_MERGED="${REMOTE_MERGED}${b}"$'\n'
    fi
  done
fi
REMOTE_MERGED_N="$(printf '%s' "$REMOTE_MERGED" | grep -c . || true)"

# ---------- open PR ----------
OPEN_PR_N="?"; OPEN_PRS=""
if [ "$HAVE_GH" = yes ]; then
  OPEN_PR_N="$(printf '%s\n' "$PR_MAP" | awk '$2=="OPEN"' | grep -c . || true)"
  OPEN_PRS="$(printf '%s\n' "$PR_MAP" | awk '$2=="OPEN"{print $1}')"
fi

# ---------- 未提交 ----------
DIRTY_N="$(git status --porcelain 2>/dev/null | grep -c . || true)"

# ---------- 汇总 ----------
CLEAN=no
if [ "$EXTRA_WT" -eq 0 ] && [ "$LOCAL_MERGED_N" -eq 0 ] && [ "$REMOTE_MERGED_N" -eq 0 ] \
   && [ "$UNPUSHED_N" -eq 0 ] && [ "$DIRTY_N" -eq 0 ] && [ "$UNKNOWN_N" -eq 0 ]; then
  CLEAN=yes
fi

echo "REPO=$ROOT"
echo "BASE=${BASE:-<none>}"
echo "CURRENT_BRANCH=$CURRENT"
echo "GH_AVAILABLE=$HAVE_GH"
echo "EXTRA_WORKTREES=$EXTRA_WT"
echo "LOCAL_MERGED_NOT_DELETED=$LOCAL_MERGED_N"
echo "REMOTE_MERGED_NOT_DELETED=$REMOTE_MERGED_N"
echo "BRANCHES_WITH_UNPUSHED=$UNPUSHED_N"
echo "UNKNOWN=$UNKNOWN_N"
echo "OPEN_PRS=$OPEN_PR_N"
echo "UNCOMMITTED_CHANGES=$DIRTY_N"
echo "CLEAN=$CLEAN"

[ -n "$LOCAL_MERGED" ] && printf '%s' "$LOCAL_MERGED" | sed '/^$/d; s/^/DETAIL_LOCAL_MERGED\t/'
[ -n "$REMOTE_MERGED" ] && printf '%s' "$REMOTE_MERGED" | sed '/^$/d; s/^/DETAIL_REMOTE_MERGED\t/'
[ -n "$UNPUSHED" ] && printf '%s' "$UNPUSHED" | sed '/^$/d; s/^/DETAIL_UNPUSHED\t/'
[ -n "$UNKNOWN" ] && printf '%s' "$UNKNOWN" | sed '/^$/d; s/^/DETAIL_UNKNOWN\t/'
[ -n "$OPEN_PRS" ] && printf '%s\n' "$OPEN_PRS" | sed 's/^/DETAIL_OPEN_PR\t/'
[ "$EXTRA_WT" -gt 0 ] && printf '%s\n' "$WT_ALL" | tail -n +2 | sed 's/^/DETAIL_EXTRA_WORKTREE\t/'
exit 0
