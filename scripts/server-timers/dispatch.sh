#!/usr/bin/env bash
# 敲钟：让 GitHub Actions 立刻开始跑，绕过它 4-5 小时的调度延迟。
#
# 服务器上【不需要本项目】：这里只发一个 HTTP 请求。业务凭据仍在 GitHub Secrets 里，
# 这台机器只持有一个只能触发 Actions 的令牌。
#
# 用法：dispatch.sh <workflow-file> [ref] [inputs-json]
#
# 成功判定：日志里出现 "OK dispatched (204)"。
#
# ⚠️ inputs-json 决定这次是"真跑"还是"演练"。GitHub 对 workflow_dispatch 里
# 没传的输入使用 workflow 声明的默认值 —— 而好几个 workflow 的 dry-run 默认是
# true。省略 inputs 时它们会正常返回 204、正常结束，但什么都不写。
# 定时触发要真产出，必须显式传：'{"dry-run":false}'。
set -u

WORKFLOW="${1:?用法: dispatch.sh <workflow-file> [ref] [inputs-json]}"
REF="${2:-main}"
INPUTS="${3:-}"
TOKEN_FILE="${TOKEN_FILE:-/etc/ai-capability-store/github-token}"
REPO="${REPO:-LyraWang6688/ai-capability-store}"
LOG="${LOG:-/var/log/ai-capability-store-dispatch.log}"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >>"$LOG" 2>/dev/null || echo "$*"; }

if [ -n "$INPUTS" ]; then
  case "$INPUTS" in
    \{*\}) ;;
    *) log "FATAL inputs must be a JSON object, got: $INPUTS"; exit 1 ;;
  esac
  PAYLOAD="{\"ref\":\"$REF\",\"inputs\":$INPUTS}"
else
  PAYLOAD="{\"ref\":\"$REF\"}"
fi

[ -r "$TOKEN_FILE" ] || { log "FATAL token file unreadable: $TOKEN_FILE"; exit 1; }
TOKEN="$(tr -d '\r\n' <"$TOKEN_FILE")"
[ -n "$TOKEN" ] || { log "FATAL token file empty: $TOKEN_FILE"; exit 1; }

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

code=$(curl -sS -o "$body" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" \
  -d "$PAYLOAD" 2>>"$LOG")

if [ "$code" = "204" ]; then
  log "OK dispatched (204) workflow=$WORKFLOW ref=$REF inputs=${INPUTS:-<defaults>}"
  exit 0
fi
log "FAIL http=$code workflow=$WORKFLOW ref=$REF inputs=${INPUTS:-<defaults>} body=$(head -c 300 "$body")"
exit 1
