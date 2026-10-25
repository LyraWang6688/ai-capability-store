#!/usr/bin/env bash
# Install the InvestDesk quote-sync automation as a launchd job.
#
#   ./install.sh               安装（幂等）
#   ./install.sh --run-now     安装后立刻触发一次，验证 launchd 环境能看见
#                              node + lark-cli
#   ./install.sh --dry-run     只渲染 plist 并打印，不落盘、不注册
#
# 代码在 Store 检出目录（本文件的上一级），状态（.env / .cache / inbox）在
# 工作目录，默认 ~/.investdesk，可用 INVESTDESK_HOME 覆盖。
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$CODE_DIR/deploy/com.investdesk.quotes.plist.template"
WORK_DIR="${INVESTDESK_HOME:-$HOME/.investdesk}"
LABEL="${LABEL:-com.investdesk.quotes}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
DRY_RUN=0
RUN_NOW=0

for arg in "$@"; do
  case "$arg" in
    --run-now) RUN_NOW=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知参数：$arg" >&2; exit 64 ;;
  esac
done

[[ -f "$TEMPLATE" ]] || { echo "找不到 plist 模板：$TEMPLATE" >&2; exit 66; }
[[ -f "$CODE_DIR/sync.ts" ]] || { echo "找不到入口：$CODE_DIR/sync.ts" >&2; exit 66; }

# --- 解析解释器 -------------------------------------------------------------
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "找不到 node，需要 Node.js 22.6+（原生跑 TS）" >&2; exit 69; }

# launchd 的 PATH 极窄：lark-cli 是 `#!/usr/bin/env node` 脚本，
# 少一个目录只会在几小时后的日志里暴露，所以这里显式构建并检查。
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

BIN_DIRS=("$(dirname "$NODE")")
for tool in lark-cli; do
  if resolved="$(command -v "$tool" 2>/dev/null)"; then
    BIN_DIRS+=("$(dirname "$resolved")")
  else
    echo "⚠️  PATH 里找不到 $tool —— 同步会因为无法写飞书而失败。" >&2
  fi
done
BIN_DIRS+=("/usr/bin" "/bin" "/usr/sbin" "/sbin")
TASK_PATH="$(build_path "${BIN_DIRS[@]}")"

mkdir -p "$WORK_DIR/.cache"
if [[ ! -f "$WORK_DIR/.env" ]]; then
  echo "⚠️  $WORK_DIR/.env 不存在。请先创建并填入 INVESTDESK_BASE_TOKEN 等配置。" >&2
fi

# --- 渲染 -------------------------------------------------------------------
render() {
  sed \
    -e "s|@@NODE@@|$NODE|g" \
    -e "s|@@CODE_DIR@@|$CODE_DIR|g" \
    -e "s|@@WORK_DIR@@|$WORK_DIR|g" \
    -e "s|@@TASK_PATH@@|$TASK_PATH|g" \
    -e "s|com.investdesk.quotes|$LABEL|g" \
    "$TEMPLATE"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  render
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents"
render > "$PLIST"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL"

echo "已安装：$PLIST"
echo "  代码：$CODE_DIR"
echo "  状态：$WORK_DIR"
echo "  时间：周一至周五 15:35、21:30"
echo "  日志：$WORK_DIR/.cache/quotes.log"

if [[ "$RUN_NOW" -eq 1 ]]; then
  echo "触发一次以验证 launchd 环境…"
  launchctl kickstart -k "gui/$UID_NUM/$LABEL"
fi
