#!/bin/bash
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.local/share/chrome-frequent-pages"
CONF_DIR="$HOME/.config/chrome-frequent-pages"
mkdir -p "$BIN_DIR" "$DATA_DIR" "$CONF_DIR"

# launchd 读不了 ~/Documents（TCC），脚本要放到不受保护的位置
cp "$HERE/main.py" "$HERE/run-if-due.sh" "$HERE/inbox-deliver-mac.py" "$HERE/table_snapshot.py" "$DATA_DIR/"
chmod +x "$DATA_DIR/main.py" "$DATA_DIR/run-if-due.sh" "$DATA_DIR/inbox-deliver-mac.py" "$DATA_DIR/table_snapshot.py"
ln -sf "$DATA_DIR/main.py" "$BIN_DIR/chrome-frequent-pages"
[ -f "$CONF_DIR/config.json" ] || cp "$HERE/config.example.json" "$CONF_DIR/config.json"

PLIST="$HOME/Library/LaunchAgents/com.lyrawang.chrome-frequent-pages.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lyrawang.chrome-frequent-pages</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$DATA_DIR/run-if-due.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$CONF_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$CONF_DIR/launchd.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.lyrawang.chrome-frequent-pages" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
echo "✓ 已安装：~/.local/bin/chrome-frequent-pages"
echo "✓ 已注册开机触发（launchd RunAtLoad，每周首次开机跑一次）"
cat <<'NOTE'

⚠️ 首次安装需在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中加入：
   /bin/bash、/usr/local/bin/node、/usr/bin/python3
   否则读不到 Chrome History（会写一条「失败」摘要到收件箱）。
NOTE
