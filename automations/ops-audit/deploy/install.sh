#!/usr/bin/env bash
# 把 ops-audit 部署到 Linux 服务器（systemd timer，每月 1 号 21:00）。
# 在**服务器上**执行；需要 root。
set -euo pipefail
APP_DIR=/opt/ops-audit
DATA_DIR=/var/lib/ops-audit
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"   # automations/ops-audit（deploy 的上一级）

sudo mkdir -p "$APP_DIR" "$DATA_DIR"
sudo cp "$ROOT/ops_audit.py" "$APP_DIR/"
if [ ! -f "$APP_DIR/config.json" ]; then
  sudo cp "$ROOT/config.example.json" "$APP_DIR/config.json"
  echo "⚠️  已放置占位配置，请编辑 $APP_DIR/config.json 填真实值（至少 runtime.local=true）。"
fi
# 记录部署来源版本，报告里会显示，用于回答"服务器跑的是哪个版本"
VERSION="$(git -C "$ROOT" describe --tags --always 2>/dev/null || echo "unknown")"
echo "$VERSION" | sudo tee "$APP_DIR/VERSION" >/dev/null

sudo cp "$HERE/ops-audit.service" "$HERE/ops-audit.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ops-audit.timer
sudo systemctl start ops-audit.service || true
echo "✅ 已安装"
echo "   下次触发：systemctl list-timers ops-audit.timer"
echo "   报告目录：$DATA_DIR/reports/"
