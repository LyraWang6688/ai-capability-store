#!/bin/bash
# command-sync 每周检查入口（由 launchd 调用）
#
# 做两件事：
#   1. scan.py all    —— 检查"有没有新命令 / 服务器项目有没有变化"
#   2. scan.py verify —— 自检"快照里的东西是否都已写进文档"（防止漏沉淀）
#
# 退出码：0 = 都正常；非 0 = 有新增或有不一致（launchd 会记录下来）

HERE="$(cd "$(dirname "$0")" && pwd)"
# scripts may live in <BASE>/bin; data lives in <BASE>
if [ -z "${COMMAND_SYNC_HOME:-}" ]; then
    if [ "$(basename "$HERE")" = "bin" ]; then COMMAND_SYNC_HOME="$(dirname "$HERE")"; else COMMAND_SYNC_HOME="$HERE"; fi
fi
export COMMAND_SYNC_HOME
cd "$COMMAND_SYNC_HOME" || exit 1
PY=/usr/bin/python3
SCAN="$HERE/scan.py"
[ -f "$SCAN" ] || SCAN="$COMMAND_SYNC_HOME/bin/scan.py"

echo "==================== $(date '+%Y-%m-%d %H:%M:%S') ===================="

$PY "$SCAN" all
rc_all=$?

echo
echo "-------------------- 文档一致性自检 --------------------"
$PY "$SCAN" verify
rc_verify=$?

echo
if [ $rc_all -eq 0 ] && [ $rc_verify -eq 0 ]; then
    echo "本次结论：✅ 无新增，文档与快照一致。"
    exit 0
fi
echo "本次结论：⚠️ 需要处理 —— 见上面清单和 pending.md。"
exit 1
