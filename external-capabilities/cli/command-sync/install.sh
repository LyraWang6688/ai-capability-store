#!/bin/bash
# command-sync 安装器：装脚本到 ~/.command-sync，并配置 Hammerspoon ⌥X 命令面板
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${COMMAND_SYNC_HOME:-$HOME/.command-sync}"
HS_DIR="$HOME/.hammerspoon"

echo "== 安装到 $BASE =="
mkdir -p "$BASE/bin" "$BASE/logs"
# 脚本用软链指向 npm 包（Store 唯一源码，不复制副本）
ln -sf "$HERE/palette.py" "$BASE/bin/palette.py"
chmod +x "$BASE/bin/palette.py"

# 1) 配置
if [ ! -f "$BASE/config.json" ]; then
    SSH_HOST="$(awk 'tolower($1)=="hostname"{print $2; exit}' "$HOME/.ssh/config" 2>/dev/null)"
    SSH_USER="$(awk 'tolower($1)=="user"{print $2; exit}' "$HOME/.ssh/config" 2>/dev/null)"
    [ -n "$SSH_USER" ] || SSH_USER="ubuntu"
    cat > "$BASE/config.json" <<EOF
{
  "history": "~/.zsh_history",
  "sshHost": "${SSH_HOST:-}",
  "sshUser": "${SSH_USER:-ubuntu}",
  "serverPaths": []
}
EOF
    echo "✓ 已生成 $BASE/config.json（可手工补充 serverPaths）"
else
    echo "✓ 配置已存在：$BASE/config.json"
fi

# 1.5) 快捷键速查表：不存在就给一份示例，存在则不动（可能已经存过东西）
if [ ! -f "$BASE/shortcuts.md" ]; then
    if [ -f "$HERE/shortcuts.example.md" ]; then
        cp "$HERE/shortcuts.example.md" "$BASE/shortcuts.md"
        echo "✓ 已生成 $BASE/shortcuts.md（可直接编辑；selection-toolbar 也会往里追加）"
    else
        echo "⚠️  缺少 shortcuts.example.md（包不完整？），面板右栏会是空的" >&2
    fi
fi

# 2) Hammerspoon 面板
if [ -d "/Applications/Hammerspoon.app" ]; then
    mkdir -p "$HS_DIR"
    cp "$HERE/hammerspoon/command-palette.lua.template" "$HS_DIR/command-palette.lua"
    # 剪贴板历史记录器：由 command-palette.lua require 加载（不另外往 init.lua 追加
    # dofile，避免同一模块被加载两次、起两个 watcher）
    cp "$HERE/hammerspoon/clip-history.lua" "$HS_DIR/clip-history.lua"
    cp "$HERE/hammerspoon/palette.html" "$BASE/palette.html"
    echo "✓ 已安装三栏面板（含剪贴板历史）HTML：$BASE/palette.html"
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

# 3) 生成首份 palette
COMMAND_SYNC_HOME="$BASE" /usr/bin/python3 "$BASE/bin/palette.py" || true

echo
echo "完成。按 ⌥X 打开命令面板。"
echo "如果面板没反应，跑一次自检：command-sync doctor"
