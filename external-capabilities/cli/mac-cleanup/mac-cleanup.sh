#!/bin/bash
# mac-cleanup —— 季度性 macOS 清理（Mole 版）
#
# 设计原则：
#   不依赖 LLM。脚本做确定性保护，人只看报告和异常。
#
# 三个不变量：
#   1. 白名单不完整 → 中止，绝不清（Mole 白名单是「替换」语义）
#   2. 不 sudo，不碰系统缓存（stdin 非 TTY 时 mole 自己会跳过）
#   3. 不信 Mole 的汇总，只认 operations.log 加总 + df 实测
#
# 首次使用：
#   ./mac-cleanup.sh --init       # 扫描本机，生成配置与清单（必做一次）
#   ./mac-cleanup.sh --check      # 只体检+预演+出报告，不删东西
#   ./install.sh                  # 安装季度定时任务
#
# 日常：
#   ./mac-cleanup.sh              # 完整跑
#   ./mac-cleanup.sh --help

set -u

# npm 的 bin 是指向本文件的符号链接 —— 先解析真实路径，否则找不到 lib/
_mc_rp() {
  local p="$1" d n=0
  while [ -L "$p" ]; do
    n=$((n + 1)); [ "$n" -le 40 ] || break
    d="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || break
    p="$(readlink "$p")" || break
    case "$p" in /*) ;; *) p="$d/$p" ;; esac
  done
  d="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$d" "$(basename "$p")"
}
MC_ROOT="$(cd "$(dirname "$(_mc_rp "${BASH_SOURCE[0]}")")" && pwd -P)"

# shellcheck source=lib/common.sh
. "${MC_ROOT}/lib/common.sh"
# shellcheck source=lib/detect.sh
. "${MC_ROOT}/lib/detect.sh"
# shellcheck source=lib/init.sh
. "${MC_ROOT}/lib/init.sh"
# shellcheck source=lib/guard.sh
. "${MC_ROOT}/lib/guard.sh"
# shellcheck source=lib/verify.sh
. "${MC_ROOT}/lib/verify.sh"

usage() {
  cat <<'EOF'
用法：
  ./mac-cleanup.sh --init [--force]   扫描本机，生成配置与清单（首次必做）
  ./mac-cleanup.sh --check            只体检 + 预演 + 出报告，不删任何东西
  ./mac-cleanup.sh                    完整跑：guard → snapshot → clean → verify → health → report
  ./mac-cleanup.sh --install          安装季度定时任务（复制包到 ~/.mac-cleanup/app 再装）
  ./mac-cleanup.sh --install --status 等  转给 install.sh：--status / --dry-run / --run-now / --uninstall
  ./mac-cleanup.sh --help             显示本帮助

退出码：
  0  正常            2  白名单体检失败（已中止，未清理）
  1  环境/配置问题    3  清理或核对异常（看报告）

安装定时任务：./install.sh   （卸载：./install.sh --uninstall）
EOF
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --init)
    shift
    run_init "${1:-}"
    exit $?
    ;;
esac

MODE="run"
case "${1:-}" in
  --install)
    shift
    # 只有【真正安装】才需要把包复制到稳定位置。
    # 只读子命令（--status / --dry-run）和 --uninstall / --run-now 直接用包里的
    # install.sh —— 否则每次查状态都往目标目录重写一遍包，在没有写权限的环境里
    # 会先报一堆 "cp: Operation not permitted" 才显示状态，卸载前还会先写一遍。
    case "${1:-}" in
      ""|--force)
        APP="${MC_STATE_DIR}/app"
        mkdir -p "${APP}" || { err "无法创建 ${APP}"; exit 1; }
        # npx 把包装在缓存目录（~/.npm/_npx/<hash>），随时会被回收 ——
        # LaunchAgent 绝不能指向那里，否则某天清理缓存后任务就静默失效。
        # 所以先复制到稳定位置，再让 install.sh 指向副本。
        cp -R "${MC_ROOT}/." "${APP}/" || { err "复制包到 ${APP} 失败"; exit 1; }
        chmod +x "${APP}/mac-cleanup.sh" "${APP}/install.sh"
        echo "已复制到稳定位置：${APP}"
        MC_APP_DIR="${APP}" exec /bin/bash "${APP}/install.sh" "$@"
        ;;
      *)
        exec /bin/bash "${MC_ROOT}/install.sh" "$@"
        ;;
    esac
    ;;
  --check) MODE="check" ;;
  "") ;;
  *) echo "未知参数：$1（用 --help）" >&2; exit 64 ;;
esac

# ── 配置与前置检查 ───────────────────────────────────────────
mc_load_config

if [ ! -f "${MC_CONFIG_LOCAL}" ] || [ ! -f "${MC_REF_WHITELIST}" ]; then
  err "还没有初始化。先跑一次：./mac-cleanup.sh --init"
  exit 1
fi

MC_MO_BIN_RESOLVED="$(detect_mo_bin)" || {
  err "找不到 mo（Mole）。先装：brew install mole"
  exit 1
}

if [ -z "$(detect_mole_base_sh)" ]; then
  warn "找不到 Mole 源码，内置白名单无法交叉验证（护栏②会降级为 WARN）"
fi

# ── 运行目录 ─────────────────────────────────────────────────
QUARTER="$(date '+%Y-Q1')"
if command -v python3 > /dev/null 2>&1; then
  QUARTER="$(python3 -c 'import datetime;d=datetime.date.today();print(f"{d.year}-Q{(d.month-1)//3+1}")' 2>/dev/null || echo "${QUARTER}")"
fi
STAMP="$(date '+%Y%m%d-%H%M%S')"
RUN_DIR="${MC_WORK_DIR}/${STAMP}"
REPORT_FILE="${MC_REPORT_DIR}/${QUARTER}.md"
FREE_BEFORE_KB="$(free_kb)"
SESSION_START="$(date '+%Y-%m-%d %H:%M:%S')"

mkdir -p "${RUN_DIR}" || { err "无法创建 ${RUN_DIR}"; exit 1; }

log "=============================================="
log "mac-cleanup 开始 | 模式=${MODE} | 季度=${QUARTER}"
log "mo: ${MC_MO_BIN_RESOLVED}"
log "可用空间 $(kb_human "${FREE_BEFORE_KB}")"
log "=============================================="

# ── ① 保护体检（不通过就中止）────────────────────────────────
log "① guard：白名单完整性 + 空条目检查"
GUARD_OUT="${RUN_DIR}/guard.txt"
if guard_whitelist "${MC_REF_WHITELIST}" "${MC_MOLE_WHITELIST}" > "${GUARD_OUT}" 2>&1; then
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

# ── ② 预演快照 ───────────────────────────────────────────────
log "② snapshot：dry-run 存档"
"${MC_MO_BIN_RESOLVED}" clean --dry-run < /dev/null > "${RUN_DIR}/dry-run.txt" 2>&1
cp "${MC_CLEAN_LIST}" "${RUN_DIR}/clean-list.txt" 2>/dev/null || true
DRY_TOTAL="$(pending_total_human "${RUN_DIR}/clean-list.txt")"
log "   待清合计：${DRY_TOTAL}"

if [ "${MODE}" = "check" ]; then
  # 资产体检是纯只读、与"清没清"无关 —— 预览模式恰恰是最该看它的时刻
  log "⑤ health：关键资产体检（只读）"
  HEALTH_OUT="${RUN_DIR}/health.txt"
  health_check > "${HEALTH_OUT}" 2>&1
  HEALTH_STATUS="$(grep -E '^VERDICT:' "${HEALTH_OUT}" | cut -d: -f2- | sed 's/^ //')"
  grep -E '^(OK|BROKEN|MISSING|SKIP|ABSENT|VERDICT)' "${HEALTH_OUT}" | sed 's/^/   /'

  write_report "${REPORT_FILE}" "${QUARTER}" "${STAMP}" \
    "CHECK-ONLY" "${FREE_BEFORE_KB}" "${FREE_BEFORE_KB}" \
    "${GUARD_STATUS}" "${DRY_TOTAL}" "未执行清理（--check）" "${RUN_DIR}" \
    "未执行（--check 不清理，没有日志可比）" "${HEALTH_STATUS}"
  log "报告：${REPORT_FILE}"
  [ "${HEALTH_STATUS}" = "BROKEN" ] && warn "关键资产体检 BROKEN —— 看 ${HEALTH_OUT}"
  exit 0
fi

# ── ③ 执行清理（非交互，自动跳过系统缓存）────────────────────
log "③ clean：mo clean（非交互）"
"${MC_MO_BIN_RESOLVED}" clean < /dev/null > "${RUN_DIR}/clean.txt" 2>&1
CLEAN_RC=$?
MO_SUMMARY="$(grep -E 'Tracked cleanup|Free space' "${RUN_DIR}/clean.txt" | tr '\n' ' ')"
log "   ${MO_SUMMARY:-（没有汇总行）}"
[ "${CLEAN_RC}" -ne 0 ] && warn "   mo clean 退出码 ${CLEAN_RC}（继续做核对）"

FREE_AFTER_KB="$(free_kb)"

# ── ④ 核对（不信汇总）────────────────────────────────────────
log "④ verify：operations.log 加总 vs 汇总 vs df"
VERIFY_OUT="${RUN_DIR}/verify.txt"
verify_clean "${MC_MOLE_LOG}" "${SESSION_START}" "${FREE_BEFORE_KB}" "${FREE_AFTER_KB}" \
  > "${VERIFY_OUT}" 2>&1
VERIFY_STATUS="$(grep -E '^VERDICT:' "${VERIFY_OUT}" | cut -d: -f2- | sed 's/^ //')"
grep -E '^(REMOVED|MISMATCH|VERDICT)' "${VERIFY_OUT}" | sed 's/^/   /'

# ── ⑤ 关键资产体检 ───────────────────────────────────────────
log "⑤ health：关键符号链接 / 受保护资产"
HEALTH_OUT="${RUN_DIR}/health.txt"
health_check > "${HEALTH_OUT}" 2>&1
HEALTH_STATUS="$(grep -E '^VERDICT:' "${HEALTH_OUT}" | cut -d: -f2- | sed 's/^ //')"
grep -E '^(OK|BROKEN|MISSING|SKIP|VERDICT)' "${HEALTH_OUT}" | sed 's/^/   /'

# ── ⑥ 报告 ───────────────────────────────────────────────────
log "⑥ report：${REPORT_FILE}"
write_report "${REPORT_FILE}" "${QUARTER}" "${STAMP}" \
  "DONE" "${FREE_BEFORE_KB}" "${FREE_AFTER_KB}" \
  "${GUARD_STATUS}" "${DRY_TOTAL}" "${MO_SUMMARY}" "${RUN_DIR}" \
  "${VERIFY_STATUS}" "${HEALTH_STATUS}"

DELTA_KB=$(( FREE_AFTER_KB - FREE_BEFORE_KB ))
log "=============================================="
log "完成 | 释放 $(kb_human "${DELTA_KB}") | 核对=${VERIFY_STATUS} | 体检=${HEALTH_STATUS}"
log "报告：${REPORT_FILE}"
log "=============================================="

if [ "${VERIFY_STATUS}" = "MISMATCH" ] || [ "${HEALTH_STATUS}" = "BROKEN" ]; then
  exit 3
fi
exit 0
