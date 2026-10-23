#!/usr/bin/env bash
# 服务器从 GitHub 拉取最新 Store，并重装全部触发器。
#
# 用法（服务器，root）：
#   sudo bash pull-store.sh
#
# 为什么不是 git clone：
#   这台服务器访问 github.com 被墙（curl 000），但 api.github.com / codeload.github.com 可通，
#   所以用官方 tarball 接口拉取，效果等同于拉仓库，且不需要 git 凭据。
#
# 幂等：可反复跑；只在 commit 变化时执行安装。
set -euo pipefail

REPO="${STORE_REPO:-LyraWang6688/ai-capability-store}"
BRANCH="${STORE_BRANCH:-main}"
SRC_DIR="${STORE_SRC_DIR:-/srv/dsh-jobs/work/store-src}"
STAMP="$SRC_DIR/.last-commit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[[ $EUID -eq 0 ]] || { echo "需要 root：sudo bash $0" >&2; exit 1; }

echo "→ 查询 $REPO@$BRANCH 最新 commit"
SHA="$(curl -sS -m 20 "https://api.github.com/repos/$REPO/commits/$BRANCH" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')"
[[ -n "$SHA" ]] || { echo "拿不到 commit sha" >&2; exit 1; }
echo "  $SHA"

if [[ -f "$STAMP" ]] && [[ "$(cat "$STAMP")" == "$SHA" ]]; then
  echo "✓ 已是最新（$SHA），无需重装"
  exit 0
fi

echo "→ 下载 tarball（codeload；失败回退 API）"
URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
if ! curl -sSL -m 120 -o "$WORK/store.tar.gz" "$URL"; then
  echo "  codeload 失败，改用 api.github.com"
  curl -sSL -m 120 -H "Accept: application/vnd.github+json" \
    -o "$WORK/store.tar.gz" "https://api.github.com/repos/$REPO/tarball/$BRANCH"
fi
tar xzf "$WORK/store.tar.gz" -C "$WORK"
SRC="$(find "$WORK" -maxdepth 1 -type d -name 'ai-capability-store-*' | head -1)"
[[ -n "$SRC" ]] || { echo "解包后找不到源码目录" >&2; exit 1; }

echo "→ 安装触发器"
bash "$SRC/scripts/server-timers/install.sh"

install -d -o dshjobs -g dshjobs "$SRC_DIR"
echo "$SHA" > "$STAMP"
chown dshjobs:dshjobs "$STAMP"
echo "✓ 完成，当前 commit $SHA"
