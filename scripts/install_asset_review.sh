#!/usr/bin/env bash
# 装 / 卸 asset-review 的 launchd 任务。
#
# 事件驱动，不是轮询：launchd 用 FSEvents 盯着三个 Domain 目录，文件一变就执行，
# 跑完就退。没有常驻进程，没有轮询循环，没有东西会「忘了关」。
#
# 为什么盯目录而不是盯 registry.yaml 本身：编辑器用「写临时文件再改名」保存时
# （vim 默认如此），被盯的那个文件 inode 就换掉了，WatchPaths 会**悄悄失效**。
# 盯目录不受影响。代价是任何文件变动都会触发一次，所以脚本第一件事是比哈希 ——
# 没变就立刻退出（约 50ms），把噪音挡在外面。
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
  <!-- 事件驱动：FSEvents 盯着三个目录，任何变动都触发。
       盯目录而不是盯 registry.yaml，是因为原子保存会换掉文件的 inode，
       让 WatchPaths 静默失效。 -->
  <key>WatchPaths</key>
  <array>
    <string>$ROOT/skills</string>
    <string>$ROOT/external-capabilities</string>
    <string>$ROOT/automations</string>
  </array>
  <!-- 冷却：连续保存时不要每一下都起进程。 -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "已安装（事件驱动，不是定时）：$PLIST"
    echo "监控：$ROOT/{skills,external-capabilities,automations}"
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
