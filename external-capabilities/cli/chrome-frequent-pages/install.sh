#!/bin/bash
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share/chrome-frequent-pages"
mkdir -p "$BIN_DIR" "$DATA_DIR" "$HOME/.config/chrome-frequent-pages"
# launchd 读不了 ~/Documents（TCC），所以把脚本复制到不受保护的目录再跑
cp "$HERE/main.py" "$DATA_DIR/main.py"
chmod +x "$DATA_DIR/main.py"
ln -sf "$DATA_DIR/main.py" "$BIN_DIR/chrome-frequent-pages"
chmod +x "$HERE/main.py"
[ -f "$HOME/.config/chrome-frequent-pages/config.json" ] || cp "$HERE/config.example.json" "$HOME/.config/chrome-frequent-pages/config.json"
PLIST="$HOME/Library/LaunchAgents/com.lyrawang.chrome-frequent-pages.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lyrawang.chrome-frequent-pages</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>$DATA_DIR/main.py</string><string>--write</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$HOME/.config/chrome-frequent-pages/run.log</string>
  <key>StandardErrorPath</key><string>$HOME/.config/chrome-frequent-pages/run.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.lyrawang.chrome-frequent-pages" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
echo "✓ 已安装：~/.local/bin/chrome-frequent-pages"
echo "✓ 已注册每周一 09:30 定时任务（launchd）"
