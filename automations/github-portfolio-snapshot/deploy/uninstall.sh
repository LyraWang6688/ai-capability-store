#!/usr/bin/env bash
# Unload the launchd job and remove its plist. The work dir (config + logs) is
# left untouched: it holds operator state, not something a migration owns.
set -euo pipefail

LABEL="${LABEL:-com.lyra.github-portfolio-snapshot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载 $LABEL 并删除 $PLIST"
echo "工作目录未动（config.json / logs 仍保留）。"
