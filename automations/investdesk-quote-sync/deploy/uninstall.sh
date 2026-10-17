#!/usr/bin/env bash
# Uninstall the InvestDesk quote-sync launchd job. State in the work dir is kept.
set -euo pipefail

LABEL="${LABEL:-com.investdesk.quotes}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载 $LABEL（工作目录与日志保留）"
