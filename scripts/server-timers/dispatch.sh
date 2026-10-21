#!/usr/bin/env bash
# 敲钟：让 GitHub Actions 立刻开始跑，绕过它 4-5 小时的调度延迟。
#
# 服务器上【不需要本项目】：这里只发一个 HTTP 请求。业务凭据仍在 GitHub Secrets 里，
# 这台机器只持有一个只能触发 Actions 的令牌。
#
# 用法：dispatch.sh <workflow-file> [ref]
# 成功判定：日志里出现 "OK dispatched (204)"。
set -u

WORKFLOW="${1:?用法: dispatch.sh <workflow-file> [ref]}"
REF="${2:-main}"
TOKEN_FILE="${TOKEN_FILE:-/etc/ai-capability-store/github-token}"
REPO="${REPO:-LyraWang6688/ai-capability-store}"
LOG="${LOG:-/var/log/ai-capability-store-dispatch.log}"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*" >>"$LOG" 2>/dev/null || echo "$*"; }

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
  -d "{\"ref\":\"$REF\"}" 2>>"$LOG")

if [ "$code" = "204" ]; then
  log "OK dispatched (204) workflow=$WORKFLOW ref=$REF"
  exit 0
fi
log "FAIL http=$code workflow=$WORKFLOW ref=$REF body=$(head -c 300 "$body")"
exit 1
