#!/usr/bin/env bash
# 部署 deepseek-invoice 到自有 Linux 服务器（systemd + headless Chromium）
# 用法：在仓库根目录执行  sudo-less:  bash automations/deepseek-invoice/deploy/install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-/opt/deepseek-invoice}"
OWNER="$(id -un)"

echo "== 1. 目录 =="
sudo mkdir -p "$TARGET/auth" "$TARGET/logs"
sudo chown -R "$OWNER":"$(id -gn)" "$TARGET"
chmod 700 "$TARGET/auth"

echo "== 2. 代码与配置 =="
cp "$SRC/run.mjs" "$SRC/lib.mjs" "$SRC/package.json" "$TARGET/"
if [ ! -f "$TARGET/config.json" ]; then
  cp "$SRC/config.example.json" "$TARGET/config.json"
  echo "⚠️  已生成 config.json 模板，请填入真实抬头/税号/邮箱后 chmod 600"
fi
chmod 600 "$TARGET/config.json" 2>/dev/null || true

echo "== 3. 登录态检查 =="
if [ ! -f "$TARGET/auth/storage-state.deepseek.json" ]; then
  echo "⚠️  缺少登录态：把本地导出的 storage-state.deepseek.json 放到 $TARGET/auth/ 并 chmod 600"
  echo "    （导出方式见 README「登录态维护」）"
fi

echo "== 4. 依赖（npm + Chromium） =="
cd "$TARGET"
npm install playwright --no-audit --no-fund --registry=https://registry.npmmirror.com
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium
sudo npx playwright install-deps chromium

echo "== 4b. 版本标记 =="
# 只认本项目的 tag：Store 是多项目共用一个仓库，--tags 会挑到别人的 tag
VERSION="$(git -C "$SRC" describe --tags --match 'deepseek-invoice-v*' --always 2>/dev/null || echo "unknown")"
echo "$VERSION" | sudo tee "$TARGET/VERSION" >/dev/null
echo "   VERSION = $VERSION"

echo "== 5. systemd =="
sudo cp "$SRC/deploy/deepseek-invoice.service" /etc/systemd/system/
sudo cp "$SRC/deploy/deepseek-invoice.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepseek-invoice.timer

echo
echo "✅ 部署完成"
echo "   手测只读： node $TARGET/run.mjs --dry-run"
echo "   查看定时： systemctl list-timers deepseek-invoice.timer"
echo "   查看日志： ls -t $TARGET/logs | head"
