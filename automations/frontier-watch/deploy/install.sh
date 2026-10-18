#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/deploy/com.lyrawang.frontier-watch.plist.tmpl"
STATE_DIR="${FRONTIER_WATCH_HOME:-$HOME/.automation-state/frontier-watch}"
LABEL="com.lyrawang.frontier-watch"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$STATE_DIR" "$HOME/Library/LaunchAgents"
sed -e "s|{{ENTRYPOINT}}|$ROOT/watch.py|g" \
    -e "s|{{WORKDIR}}|$ROOT|g" \
    -e "s|{{STATE_DIR}}|$STATE_DIR|g" \
    "$TEMPLATE" > "$TARGET"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
echo "installed: $TARGET"
echo "run now: python3 $ROOT/watch.py"
