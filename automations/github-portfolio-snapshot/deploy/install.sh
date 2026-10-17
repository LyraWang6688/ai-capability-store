#!/usr/bin/env bash
# Install the monthly GitHub portfolio snapshot as a launchd job.
#
#   ./install.sh                 install (idempotent)
#   ./install.sh --run-now       install, then kick it once to prove the
#                                launchd environment can see gh / lark-cli
#   ./install.sh --dry-run       render the plist and print it; touch nothing
#
# The CODE lives in the Store checkout (this directory's parent); the STATE
# (config.json + logs) lives in a work dir. Both are independent, which is why
# this script renders a template instead of shipping a fixed plist.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$CODE_DIR/deploy/com.lyra.github-portfolio-snapshot.plist.template"
WORK_DIR="${GITHUB_SNAPSHOT_HOME:-$HOME/github-portfolio-snapshot}"
LABEL="${LABEL:-com.lyra.github-portfolio-snapshot}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --run-now) RUN_NOW=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数：$arg" >&2; exit 64 ;;
  esac
done
RUN_NOW="${RUN_NOW:-0}"

[[ -f "$TEMPLATE" ]] || { echo "找不到 plist 模板：$TEMPLATE" >&2; exit 66; }
[[ -f "$CODE_DIR/snapshot.py" ]] || { echo "找不到入口：$CODE_DIR/snapshot.py" >&2; exit 66; }

# --- resolve binaries -------------------------------------------------------
PYTHON="$(command -v python3 || true)"
[[ -n "$PYTHON" ]] || { echo "找不到 python3" >&2; exit 69; }

# launchd's PATH is extremely narrow: lark-cli is a `#!/usr/bin/env node` script
# and gh may be installed under /opt/homebrew, so every interpreter directory is
# injected explicitly. Missing a tool here surfaces only in the launchd log,
# hours later — hence the explicit check below.
build_path() {
  local seen=":" out=""
  for d in "$@"; do
    [[ -d "$d" ]] || continue
    case "$seen" in *":$d:"*) continue ;; esac
    seen="$seen$d:"
    out="${out:+$out:}$d"
  done
  printf '%s' "$out"
}

BIN_DIRS=("$(dirname "$PYTHON")")
for tool in node gh lark-cli; do
  if resolved="$(command -v "$tool" 2>/dev/null)"; then
    BIN_DIRS+=("$(dirname "$resolved")")
  else
    echo "⚠️  PATH 里找不到 $tool —— 快照运行时会失败。请先安装或修正 PATH。" >&2
  fi
done
TASK_PATH="$(build_path "${BIN_DIRS[@]}" /usr/bin /bin /usr/sbin /sbin /usr/local/bin)"

# --- render -----------------------------------------------------------------
# bash parameter expansion, not sed: the substituted values are filesystem
# paths and may contain characters sed would treat as syntax.
render() {
  local body
  body="$(cat "$TEMPLATE")"
  body="${body//@@PYTHON@@/$PYTHON}"
  body="${body//@@CODE_DIR@@/$CODE_DIR}"
  body="${body//@@WORK_DIR@@/$WORK_DIR}"
  body="${body//@@TASK_PATH@@/$TASK_PATH}"
  if [[ "$LABEL" != "com.lyra.github-portfolio-snapshot" ]]; then
    body="${body//com.lyra.github-portfolio-snapshot/$LABEL}"
  fi
  printf '%s\n' "$body"
}

echo "==> code dir : $CODE_DIR"
echo "==> work dir : $WORK_DIR"
echo "==> label    : $LABEL"

if [[ "$DRY_RUN" == "1" ]]; then
  render
  exit 0
fi

mkdir -p "$WORK_DIR/logs" "$HOME/Library/LaunchAgents"

if [[ ! -f "$WORK_DIR/config.json" ]]; then
  cp "$CODE_DIR/config.example.json" "$WORK_DIR/config.json"
  echo
  echo "⚠️  已创建工作目录配置文件：$WORK_DIR/config.json"
  echo "    这是模板，必须填入 github_login / base_token / registry_table 才会运行。"
  echo "    填好后重新执行本脚本。"
  exit 78
fi

echo "==> 渲染 $PLIST"
render > "$PLIST"

echo "==> 重新加载 LaunchAgent"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"

echo "==> 当前状态"
launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null \
  | grep -E "^\s*(state|program|runs|last exit code)" || true

if [[ "$RUN_NOW" == "1" ]]; then
  echo "==> 立刻触发一次（验证 launchd 环境下 gh / lark-cli 是否可用）"
  launchctl kickstart -p "gui/$UID_NUM/$LABEL" || true
  sleep 8
  echo "--- stdout ---"; tail -20 "$WORK_DIR/logs/launchd.out.log" 2>/dev/null || echo "(无)"
  echo "--- stderr ---"; tail -20 "$WORK_DIR/logs/launchd.err.log" 2>/dev/null || echo "(无)"
fi

echo "==> 完成。下次运行：每月 1 日 20:00"
