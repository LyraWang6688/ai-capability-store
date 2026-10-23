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

SNAP_BEFORE="$(python3 "$HERE/table_snapshot.py" 2>/dev/null || echo '{}')"
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
SNAP_AFTER="$(python3 "$HERE/table_snapshot.py" 2>/dev/null || echo '{}')"
DETAIL="$(python3 - "$SNAP_BEFORE" "$SNAP_AFTER" <<'PYD'
import json, sys
before = json.loads(sys.argv[1] or "{}")
after = json.loads(sys.argv[2] or "{}")
new = [(h, v) for h, v in after.items() if h not in before]
if not new:
    print("本周无新增页面")
else:
    parts = []
    for host, v in new[:5]:
        cat = v.get("cat") or "其他"
        tag = "未分类→其他" if cat == "其他" else cat
        parts.append(f"{v.get('title') or host}（{host}）→ 书签「{tag}」")
    more = "" if len(new) <= 5 else f" 等 {len(new)} 条"
    print("新增：" + "；".join(parts) + more)
PYD
)"
python3 "$HERE/inbox-deliver-mac.py" --task chrome-frequent-pages --result 成功 \
  --summary "$DETAIL；$LINE" >> "$LOG" 2>&1 || log "inbox deliver failed"
python3 - "$STATE" "$WEEK" <<'PY'
import json, sys, datetime
json.dump({"week": sys.argv[2], "at": datetime.datetime.now().isoformat(timespec="seconds")}, open(sys.argv[1], "w"), ensure_ascii=False)
PY
log "done week=$WEEK result=$LINE"
