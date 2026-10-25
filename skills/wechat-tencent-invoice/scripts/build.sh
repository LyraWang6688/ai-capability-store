#!/usr/bin/env bash
# 编译 ui.swift → ui（每台设备一次；ui 是产物，不入 git）。
#
# 两种情况都会自动处理：
#   - 还没有 ui            → 编译
#   - 有 ui 但跑不起来（常见原因：压缩包是另一架构编译的）→ 删掉重编
#
# 依赖：Swift 编译器（Xcode Command Line Tools 自带）。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ "$(uname -m)" != "arm64" ]; then
  cat >&2 <<'MSG'
本 skill 当前只支持 Apple Silicon（arm64）。
当前机器是 $(uname -m)（Intel）—— 不在支持范围：预编译的 ui 跑不起来，
源码重编出来的产物也没有实机验证过。请换 arm64 机器，或自行改造（本仓库不维护 Intel 路径）。
MSG
  exit 1
fi

if [ -x "$here/ui" ]; then
  if ! "$here/ui" status >/dev/null 2>&1; then
    echo "现有 ui 跑不起来（多为架构不符），重新编译"
    rm -f "$here/ui"
  elif [ "$here/ui.swift" -nt "$here/ui" ]; then
    echo "ui.swift 比 ui 新，重新编译"
    rm -f "$here/ui"
  else
    echo "ui 已存在且是最新的：$here/ui（无需重编）"
    exit 0
  fi
fi

if ! command -v swiftc >/dev/null 2>&1; then
  cat >&2 <<'MSG'
缺少 swiftc（Swift 编译器）。
- 若你拿到的是「预编译包」，说明本机架构与包不一致（arm64 ↔ x86_64）。
- 修法：终端执行  xcode-select --install  装 Command Line Tools（约 1-2 GB），
        或  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
        指向已安装的 Xcode；装完重跑本脚本。
MSG
  exit 1
fi

swiftc -O "$here/ui.swift" -o "$here/ui"
echo "built: $here/ui"
echo "下一步：bash scripts/ui doctor（逐项检查权限与依赖）"
