#!/usr/bin/env bash
# 从 GitHub 拉最新代码并重建机器人容器。在服务器上执行。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
BOT_DIR="$REPO_ROOT/external-capabilities/connectors/investdesk-bot"

echo "==> 仓库: $REPO_ROOT"
cd "$REPO_ROOT"
BEFORE="$(git rev-parse --short HEAD)"
git pull --ff-only
AFTER="$(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "==> 代码已是最新 ($AFTER)，仍重建以确保一致"
else
  echo "==> 更新 $BEFORE → $AFTER"
fi

cd "$BOT_DIR"
[ -f .env ] || { echo "缺少 .env，请先创建（参考 .env.example）"; exit 1; }
docker compose up -d --build
sleep 6
docker compose logs --tail 8
echo "==> 完成"
