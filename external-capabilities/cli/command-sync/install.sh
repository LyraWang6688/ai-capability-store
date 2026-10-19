#!/bin/bash
# command-sync 安装器：把脚本装到 ~/.command-sync，并配置 launchd 月度巡检 + Hammerspoon ⌥X 面板
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${COMMAND_SYNC_HOME:-$HOME/.command-sync}"
LABEL="com.wangying.command-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HS_DIR="$HOME/.hammerspoon"

echo "== 安装到 $BASE =="
mkdir -p "$BASE/bin" "$BASE/reports" "$BASE/logs"
cp "$HERE/palette.py" "$HERE/scan.py" "$HERE/run-check.sh" "$BASE/bin/"
chmod +x "$BASE"/bin/*

# 1) 配置
if [ ! -f "$BASE/config.json" ]; then
    SSH_HOST="$(awk 'tolower($1)=="hostname"{print $2; exit}' "$HOME/.ssh/config" 2>/dev/null)"
    SSH_USER="$(awk 'tolower($1)=="user"{print $2; exit}' "$HOME/.ssh/config" 2>/dev/null)"
    [ -n "$SSH_USER" ] || SSH_USER="ubuntu"
    OLD_PATHS="$HOME/command-sync/known-server-paths.json"
    if [ -f "$OLD_PATHS" ]; then
        PATHS_JSON="$(/usr/bin/python3 - "$OLD_PATHS" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    print(json.dumps(d.get("paths") or [], ensure_ascii=False))
except Exception:
    print("[]")
PY
)"
        [ -n "$PATHS_JSON" ] || PATHS_JSON="[]"
    else
        PATHS_JSON="[]"
    fi
    cat > "$BASE/config.json" <<EOF
{
  "history": "~/.zsh_history",
  "sshHost": "${SSH_HOST:-}",
  "sshUser": "${SSH_USER:-ubuntu}",
  "serverPaths": $PATHS_JSON
}
EOF
    echo "✓ 已生成 $BASE/config.json（可手工补充 serverPaths）"
else
    echo "✓ 配置已存在：$BASE/config.json"
fi

# 2) 迁移旧目录的数据（如果存在）
OLD="$HOME/command-sync"
if [ -d "$OLD" ]; then
    for f in known-commands.json known-programs.json known-server-paths.json known-repos.json git-commands.md other-commands.md server-projects.md; do
        if [ -f "$OLD/$f" ] && [ ! -f "$BASE/$f" ]; then
            cp "$OLD/$f" "$BASE/$f"
            echo "  · 迁移 $f"
        fi
    done
    if [ -d "$OLD/reports" ] && [ -z "$(ls -A "$BASE/reports" 2>/dev/null)" ]; then
        cp -R "$OLD/reports/." "$BASE/reports/" 2>/dev/null || true
    fi
    for d in "$OLD"/history-dump*.txt; do
        [ -e "$d" ] || continue
        cp "$d" "$BASE/" 2>/dev/null || true
    done
fi

# 3) launchd 月度巡检
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BASE/bin/run-check.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>COMMAND_SYNC_HOME</key><string>$BASE</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Day</key><integer>1</integer><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$BASE/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$BASE/logs/launchd.err.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
echo "✓ launchd 巡检已安装（每月 1 号 21:00）"

# 4) Hammerspoon 面板
if [ -d "/Applications/Hammerspoon.app" ]; then
    mkdir -p "$HS_DIR"
    cp "$HERE/hammerspoon/command-palette.lua.template" "$HS_DIR/command-palette.lua"
    if ! grep -q 'command-palette.lua' "$HS_DIR/init.lua" 2>/dev/null; then
        printf '\n-- command-sync palette\ndofile(hs.configdir .. "/command-palette.lua")\n' >> "$HS_DIR/init.lua"
    fi
    open -a /Applications/Hammerspoon.app 2>/dev/null || true
    HS_BIN=""
    [ -x /opt/homebrew/bin/hs ] && HS_BIN=/opt/homebrew/bin/hs
    [ -x /usr/local/bin/hs ] && HS_BIN=/usr/local/bin/hs
    [ -n "$HS_BIN" ] && "$HS_BIN" -c 'hs.reload()' >/dev/null 2>&1 || true
    echo "✓ Hammerspoon 面板已安装（⌥X）"
else
    echo "⚠️  未安装 Hammerspoon：brew install --cask hammerspoon 后重新运行本脚本"
fi

# 5) 生成首份 palette
COMMAND_SYNC_HOME="$BASE" /usr/bin/python3 "$BASE/bin/palette.py" || true

echo
echo "完成。按 ⌥X 打开命令面板；月度巡检：launchctl print gui/$(id -u)/$LABEL"
