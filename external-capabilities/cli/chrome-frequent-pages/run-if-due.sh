#!/bin/bash
# 开机触发：每周只跑一次（ISO 周去重）。由 launchd 的 RunAtLoad 调用。
set -u
STATE_DIR="$HOME/.config/chrome-frequent-pages"
STATE="$STATE_DIR/last-run.json"
LOG="$STATE_DIR/run-if-due.log"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
WEEK="$(date +%G-%V)"
mkdir -p "$STATE_DIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

LAST=""
if [ -f "$STATE" ]; then
  LAST="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("week",""))' "$STATE" 2>/dev/null || true)"
fi
if [ "$LAST" = "$WEEK" ]; then
  log "skip: week $WEEK already ran"
  exit 0
fi

OUT="$(chrome-frequent-pages --write 2>&1)"
CODE=$?
if [ $CODE -ne 0 ]; then
  log "run failed (exit $CODE): $(echo "$OUT" | tail -3 | tr '\n' ' ')"
  python3 "$HERE/inbox-deliver-mac.py" --task chrome-frequent-pages --result 失败 \
    --summary "chrome-frequent-pages 执行失败：$(echo "$OUT" | tail -1 | cut -c1-70)" >> "$LOG" 2>&1 || true
  exit 1
fi

LINE="$(echo "$OUT" | grep -o '飞书写入完成：.*' | tail -1)"
[ -z "$LINE" ] && LINE="$(echo "$OUT" | tail -1)"
python3 "$HERE/inbox-deliver-mac.py" --task chrome-frequent-pages --result 成功 \
  --summary "chrome-frequent-pages 已完成：$LINE" >> "$LOG" 2>&1 || log "inbox deliver failed"
python3 - "$STATE" "$WEEK" <<'PY'
import json, sys, datetime
json.dump({"week": sys.argv[2], "at": datetime.datetime.now().isoformat(timespec="seconds")}, open(sys.argv[1], "w"), ensure_ascii=False)
PY
log "done week=$WEEK result=$LINE"
