#!/usr/bin/env bash
# 把「所有触发器」装到服务器。
#
# 目录约定：
#   systemd/*.service|*.timer   → /etc/systemd/system/（唯一触发器形式）
#   dispatch.sh                 → /usr/local/bin/ai-capability-store-dispatch
#   deliver/*                   → /srv/dsh-jobs/scripts/（dshjobs 身份）
#
# 历史：2026-10-24 之前 cron 类触发器在 timers/*.cron，已全部迁成 systemd timer；
# 本脚本会把 /etc/cron.d 里对应的旧文件删掉，避免同一件事有两个钟。
#
# 幂等：可以反复跑。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS="$HERE/systemd"
DELIVER_SRC="$HERE/deliver"
BIN="/usr/local/bin/ai-capability-store-dispatch"
CRON_D="/etc/cron.d"
SCRIPTS_DIR="/srv/dsh-jobs/scripts"
LOG_DIR="/srv/dsh-jobs/logs"

[[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0" >&2; exit 1; }
[[ -d "$UNITS" ]] || { echo "找不到 $UNITS" >&2; exit 66; }

# 1) dispatch 脚本
install -m 0755 "$HERE/dispatch.sh" "$BIN"
echo "✓ 脚本  $BIN"

# 2) 投递脚本（dshjobs 身份，只它持有飞书凭据）
install -d -m 0755 "$SCRIPTS_DIR" "$LOG_DIR"
for f in "$DELIVER_SRC"/*; do
  [ -f "$f" ] || continue
  install -m 0700 -o dshjobs -g dshjobs "$f" "$SCRIPTS_DIR/$(basename "$f")"
  echo "✓ 投递脚本 $SCRIPTS_DIR/$(basename "$f")"
done

# 2b) 远程接收入口（GitHub Actions → 服务器 DSH）
#     脚本装到 $SCRIPTS_DIR，SSH 的 forced command 指向 /usr/local/bin/automation-accept。
REMOTE_SRC="$HERE/remote"
if [[ -d "$REMOTE_SRC" ]]; then
  for f in "$REMOTE_SRC"/*.py; do
    [ -f "$f" ] || continue
    install -m 0700 -o dshjobs -g dshjobs "$f" "$SCRIPTS_DIR/$(basename "$f")"
    echo "✓ 接收脚本 $SCRIPTS_DIR/$(basename "$f")"
  done
  cat > /usr/local/bin/automation-accept <<'WRAP'
#!/bin/sh
exec sudo -n runuser -u dshjobs -- env HOME=/srv/dsh-jobs /srv/dsh-jobs/scripts/dispatch.py
WRAP
  chmod 0755 /usr/local/bin/automation-accept
  echo "✓ 接收入口 /usr/local/bin/automation-accept"
fi

# 2c) 报告托管目录（nginx 静态站点根）
install -d -m 0755 -o dshjobs -g dshjobs /srv/automation/www/reports
echo "✓ 报告目录 /srv/automation/www/reports"

# 3) systemd 单元
for f in "$UNITS"/*; do
  [ -f "$f" ] || continue
  install -m 0644 "$f" "/etc/systemd/system/$(basename "$f")"
  echo "✓ 单元 $(basename "$f")"
done
systemctl daemon-reload

# 4) 启用 timer
for t in "$UNITS"/*.timer; do
  [ -f "$t" ] || continue
  name="$(basename "$t")"
  systemctl enable --now "$name" >/dev/null
  echo "✓ 已启用 $name"
done

# 5) 清理迁走的历史 cron（同名文件）
LEGACY_CRONS=(
  box2bitable-observability frontier-watch github-portfolio-snapshot
  github-trending-daily github-trending-weekly investdesk-quote-sync
  repo-baseline-audit repo-discoverability
)
for name in "${LEGACY_CRONS[@]}"; do
  if [[ -f "$CRON_D/$name" ]]; then
    rm -f "$CRON_D/$name" && echo "✓ 移除旧 cron $CRON_D/$name"
  fi
done

# 6) 清理旧的固定投递 timer（现在由 OnSuccess/OnFailure 触发）
for legacy in ops-audit-inbox.timer deepseek-invoice-inbox.timer; do
  if [[ -f "/etc/systemd/system/$legacy" ]]; then
    systemctl disable --now "$legacy" 2>/dev/null || true
    rm -f "/etc/systemd/system/$legacy" && echo "✓ 移除旧投递 timer $legacy"
  fi
done
systemctl daemon-reload

echo
echo "查看触发器：systemctl list-timers --all | grep -E '($(IFS='|'; echo "${LEGACY_CRONS[*]}")|ops-audit|deepseek-invoice)'"
