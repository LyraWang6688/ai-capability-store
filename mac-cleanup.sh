#!/bin/bash
# mac-cleanup —— 季度性 macOS 清理（Mole 版）
#
# 设计原则（和 repo-hygiene 同一套）：
#   LLM 不做判断。脚本做确定性保护。人只看报告和异常。
#
# 三个不变量：
#   1. 白名单不完整 → 中止，绝不清（Mole 的白名单是「替换」语义）
#   2. 不 sudo，不问系统缓存（stdin 非 TTY 时 mole 自动跳过）
#   3. 不信 Mole 的汇总，只认 operations.log 加总 + df 实测
#
# 用法：
#   mac-cleanup.sh            # 完整跑：guard → snapshot → clean → verify → health → report
#   mac-cleanup.sh --check    # 只跑 guard + dry-run + report，不删任何东西
#   mac-cleanup.sh --help

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${PROJECT_DIR}/lib/common.sh"
# shellcheck source=lib/guard.sh
. "${PROJECT_DIR}/lib/guard.sh"
# shellcheck source=lib/verify.sh
. "${PROJECT_DIR}/lib/verify.sh"

MODE="run"
case "${1:-}" in
  --check) MODE="check" ;;
  --help|-h)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "") ;;
  *) echo "未知参数: $1（用 --help）" >&2; exit 64 ;;
esac

QUARTER="$(date '+%Y-Q')"
if command -v python3 >/dev/null 2>&1; then
  QUARTER="$(python3 -c 'import datetime;d=datetime.date.today();print(f"{d.year}-Q{(d.month-1)//3+1}")' 2>/dev/null || echo "${QUARTER}")"
fi
STAMP="$(date '+%Y%m%d-%H%M%S')"
RUN_DIR="${WORK_DIR}/${STAMP}"
REPORT_FILE="${REPORT_DIR}/${QUARTER}.md"

FREE_BEFORE_KB="$(free_kb)"
SESSION_START="$(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "${RUN_DIR}" || { err "无法创建 ${RUN_DIR}"; exit 1; }

log "=============================================="
log "mac-cleanup 开始 | 模式=${MODE} | 季度=${QUARTER}"
log "可用空间 ${FREE_BEFORE_KB} KB ($(kb_human "${FREE_BEFORE_KB}"))"
log "=============================================="

# ── 阶段 1：保护体检（不通过就中止）────────────────────────────
log "① guard：白名单完整性 + 空条目检查"
GUARD_OUT="${RUN_DIR}/guard.txt"
if guard_whitelist "${PROJECT_DIR}/whitelist.reference" "${MOLE_WHITELIST}" > "${GUARD_OUT}" 2>&1; then
  log "   ✅ 白名单体检通过"
  GUARD_STATUS="PASS"
else
  err "   ❌ 白名单体检失败 —— 已中止，本次不做任何清理"
  sed 's/^/      /' "${GUARD_OUT}" >&2
  GUARD_STATUS="FAIL"
  write_report "${REPORT_FILE}" "${QUARTER}" "${STAMP}" \
    "ABORTED" "${FREE_BEFORE_KB}" "${FREE_BEFORE_KB}" \
    "${GUARD_STATUS}" "" "" ""
  exit 2
fi
grep -E '^(WARN|FAIL)' "${GUARD_OUT}" | sed 's/^/      /' || true

if [ "${MODE}" = "check" ]; then
  log "② snapshot：dry-run（--check 模式，不执行清理）"
  "${MO_BIN}" clean --dry-run < /dev/null > "${RUN_DIR}/dry-run.txt" 2>&1
  cp "${CLEAN_LIST}" "${RUN_DIR}/clean-list.txt" 2>/dev/null || true
  DRY_TOTAL="$(pending_total_human "${RUN_DIR}/clean-list.txt")"
  log "   待清合计：${DRY_TOTAL}"
  write_report "${REPORT_FILE}" "${QUARTER}" "${STAMP}" \
    "CHECK-ONLY" "${FREE_BEFORE_KB}" "${FREE_BEFORE_KB}" \
    "${GUARD_STATUS}" "${DRY_TOTAL}" "未执行清理（--check）" "${RUN_DIR}"
  log "报告：${REPORT_FILE}"
  exit 0
fi

# ── 阶段 2：预演快照 ──────────────────────────────────────────
log "② snapshot：dry-run 存档"
"${MO_BIN}" clean --dry-run < /dev/null > "${RUN_DIR}/dry-run.txt" 2>&1
cp "${CLEAN_LIST}" "${RUN_DIR}/clean-list.txt" 2>/dev/null || true
DRY_TOTAL="$(pending_total_human "${RUN_DIR}/clean-list.txt")"
log "   待清合计：${DRY_TOTAL}"

# ── 阶段 3：执行清理（非交互，自动跳过系统缓存）────────────────
log "③ clean：mo clean（非交互）"
"${MO_BIN}" clean < /dev/null > "${RUN_DIR}/clean.txt" 2>&1
CLEAN_RC=$?
MO_SUMMARY="$(grep -E 'Tracked cleanup|Free space' "${RUN_DIR}/clean.txt" | tr '\n' ' ')"
log "   ${MO_SUMMARY:-（没有汇总行）}"
[ "${CLEAN_RC}" -ne 0 ] && warn "   mo clean 退出码 ${CLEAN_RC}（继续做核对）"

FREE_AFTER_KB="$(free_kb)"

# ── 阶段 4：核对（不信汇总）──────────────────────────────────
log "④ verify：operations.log 加总 vs 汇总 vs df"
VERIFY_OUT="${RUN_DIR}/verify.txt"
verify_clean "${MOLE_LOG}" "${SESSION_START}" "${FREE_BEFORE_KB}" "${FREE_AFTER_KB}" \
  > "${VERIFY_OUT}" 2>&1
VERIFY_STATUS="$(grep -E '^VERDICT:' "${VERIFY_OUT}" | cut -d: -f2- | sed 's/^ //')"
grep -E '^(REMOVED|MISMATCH|VERDICT)' "${VERIFY_OUT}" | sed 's/^/   /'

# ── 阶段 5：关键资产体检 ──────────────────────────────────────
log "⑤ health：关键符号链接 / 受保护资产"
HEALTH_OUT="${RUN_DIR}/health.txt"
health_check > "${HEALTH_OUT}" 2>&1
HEALTH_STATUS="$(grep -E '^VERDICT:' "${HEALTH_OUT}" | cut -d: -f2- | sed 's/^ //')"
grep -E '^(OK|BROKEN|MISSING|VERDICT)' "${HEALTH_OUT}" | sed 's/^/   /'

# ── 阶段 6：报告 ─────────────────────────────────────────────
log "⑥ report：${REPORT_FILE}"
DELTA_KB=$(( FREE_AFTER_KB - FREE_BEFORE_KB ))
write_report "${REPORT_FILE}" "${QUARTER}" "${STAMP}" \
  "DONE" "${FREE_BEFORE_KB}" "${FREE_AFTER_KB}" \
  "${GUARD_STATUS}" "${DRY_TOTAL}" "${MO_SUMMARY}" "${RUN_DIR}" \
  "${VERIFY_STATUS}" "${HEALTH_STATUS}"

log "=============================================="
log "完成 | 释放 $(kb_human "${DELTA_KB}") | 核对=${VERIFY_STATUS} | 体检=${HEALTH_STATUS}"
log "报告：${REPORT_FILE}"
log "=============================================="
