#!/usr/bin/env bash
# 把总目录里的定时器装到服务器。
#
#   1. dispatch.sh          → /usr/local/bin/ai-capability-store-dispatch
#   2. timers/*.cron        → /etc/ai-capability-store/timers/  （源）
#   3. timers/*.cron        → /etc/cron.d/<name>                （cron 只读这里）
#   4. 移除历史遗留的重复定时器（迁进总目录之前的旧位置）
#
# 幂等：可以反复跑。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TIMERS_SRC="$HERE/timers"
TIMERS_DIR="/etc/ai-capability-store/timers"
BIN="/usr/local/bin/ai-capability-store-dispatch"
CRON_D="/etc/cron.d"

[[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0" >&2; exit 1; }
[[ -d "$TIMERS_SRC" ]] || { echo "找不到 $TIMERS_SRC" >&2; exit 66; }

install -d -m 0755 "$TIMERS_DIR"
install -m 0755 "$HERE/dispatch.sh" "$BIN"
echo "✓ 脚本  $BIN"

for f in "$TIMERS_SRC"/*.cron; do
  [ -f "$f" ] || continue
  name="$(basename "$f" .cron)"
  install -m 0644 "$f" "$TIMERS_DIR/$name.cron"
  install -m 0644 "$f" "$CRON_D/$name"
  echo "✓ 定时器 $name"
done

# 迁进总目录之前的旧位置，逐个清掉（避免同一件事有两个钟）
LEGACY_BIN="/usr/local/bin/investdesk-quote-sync-trigger"
if [[ -f "$LEGACY_BIN" ]] && ! grep -q "ai-capability-store-dispatch" /etc/cron.d/investdesk-quote-sync 2>/dev/null; then
  : # 已经被新文件覆盖，下面只报告
fi
if [[ -f "$LEGACY_BIN" ]]; then
  rm -f "$LEGACY_BIN" && echo "✓ 移除旧脚本 $LEGACY_BIN"
fi
if crontab -u ubuntu -l 2>/dev/null | grep -q "box2bitable-observability-daily"; then
  crontab -u ubuntu -l 2>/dev/null | grep -v "box2bitable-observability-daily" | crontab -u ubuntu -
  echo "✓ 从 ubuntu 的 crontab 里移除了 box2bitable 那一行（现在由 /etc/cron.d 管）"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl reload cron 2>/dev/null || service cron reload 2>/dev/null || true
fi
echo
echo "装好了。验证："
echo "  ls -l $TIMERS_DIR"
echo "  ls -l $CRON_D"
echo "  crontab -u ubuntu -l   # 应该已经没有 box2bitable 那一行了"
