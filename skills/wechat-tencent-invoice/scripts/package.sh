#!/usr/bin/env bash
# 把整个 skill 打包成一个可分发的 tar.gz，**包里带编译好的 ui**。
#
# 为什么要有这一步：ui 是编译产物，按 Store 规则不入 git；但别人拿到源码包
# 得先装 Swift 工具链才能编。这个脚本在**打包时**编译一次，把产物一起塞进压缩包，
# 于是接收方解压即可用（同架构时）。
#
# 用法：
#   bash scripts/package.sh              # 输出到 skills/wechat-tencent-invoice/dist/
#   bash scripts/package.sh /some/dir    # 输出到指定目录
#
# 产物名：wechat-tencent-invoice-<version>-<arch>.tar.gz
# version 取自 skills/registry.yaml（唯一事实源）。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
skill_dir="$(cd "$here/.." && pwd)"
store_root="$(cd "$skill_dir/../.." && pwd)"
out_dir="${1:-$skill_dir/dist}"

# ---- 版本：只认注册表 ----
version="$(python3 - "$store_root/skills/registry.yaml" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^  wechat-tencent-invoice:\n(?:.*\n)*?    version: "?([0-9]+\.[0-9]+\.[0-9]+)"?', text, re.M)
print(m.group(1) if m else '')
PY
)"
if [ -z "$version" ]; then
  echo "读不到版本号：skills/registry.yaml 里没有 wechat-tencent-invoice 的 version" >&2
  exit 1
fi

# ---- 先编译（同架构时这条就是"预编译程序"的来源）----
bash "$here/build.sh" >/dev/null

arch="$(uname -m)"
name="wechat-tencent-invoice-${version}-${arch}"
mkdir -p "$out_dir"
tarball="$out_dir/${name}.tar.gz"

# 只打发布需要的东西：说明 / references / scripts（含已编译的 ui）。排除 dist 自身与杂项。
tar --exclude='dist' --exclude='.DS_Store' --exclude='__pycache__' \
    -czf "$tarball" -C "$skill_dir" SKILL.md agents references scripts

# ---- 自证：解到临时目录，确认包是自足的 ----
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$tarball" -C "$tmp"
if [ ! -x "$tmp/scripts/ui" ]; then
  echo "包内没有可执行的 scripts/ui —— 打包失败" >&2
  exit 1
fi
if ! "$tmp/scripts/ui" status >/dev/null 2>&1; then
  echo "包内的 ui 跑不起来（架构不符或缺权限？）—— 打包失败" >&2
  exit 1
fi

echo "打包完成：$tarball"
echo "内容："
tar -tzf "$tarball" | sed 's/^/  /'
echo "sha256：$(shasum -a 256 "$tarball" | awk '{print $1}')"
echo
echo "接收方解压后："
echo "  1) bash scripts/ui doctor     # 检查权限（同架构时无需 swiftc）"
echo "  2) 按 SKILL.md 走流程"
echo "如果对方是另一架构（arm64 ↔ x86_64）：ui 会跑不起来，改用 build.sh 重编（需 Swift 工具链）。"
