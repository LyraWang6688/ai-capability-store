#!/usr/bin/env bash
# 装 / 卸 asset-review 的 launchd 任务。
#
# 为什么是 launchd 而不是 cron 或常驻进程：它每 5 分钟起一次，跑完就退出。
# 没有守护进程、没有轮询循环、没有东西会「忘了关」。机器睡着时不跑，醒来后的
# 第一个间隔会补上 —— 而那正是你在编辑代码的时候。
#
#   bash scripts/install_asset_review.sh install
#   bash scripts/install_asset_review.sh uninstall
#   bash scripts/install_asset_review.sh status
set -u

LABEL="com.lyrawang.asset-review"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
SCRIPT="$ROOT/scripts/asset_review.py"
LOG="$HOME/.ai-capability-store/asset-review/launchd.log"

case "${1:-}" in
  install)
    [ -x "$PYTHON" ] || { echo "找不到 $PYTHON —— 先建 .venv" >&2; exit 1; }
    [ -f "$SCRIPT" ] || { echo "找不到 $SCRIPT" >&2; exit 1; }
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$SCRIPT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <!-- 每 5 分钟一次。机器睡着不跑，醒来后补上。 -->
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "已安装：$PLIST"
    echo "日志：$LOG"
    echo "报告：$HOME/.ai-capability-store/asset-review/reports/"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已卸载"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>&1 | head -12
    ;;
  *)
    echo "用法: $0 install|uninstall|status" >&2
    exit 2
    ;;
esac
