#!/bin/bash
# 安装 / 卸载季度清理的 LaunchAgent
#
#   ./install.sh             安装（生成 plist → ~/Library/LaunchAgents → 注册到 launchd）
#   ./install.sh --status    查看状态与下次运行时间
#   ./install.sh --run-now   立刻跑一次（调试用）
#   ./install.sh --uninstall 卸载
#   ./install.sh --dry-run   只打印将要生成的 plist，不写任何文件
#
# 前置：先跑过 ./mac-cleanup.sh --init（否则没有 config.local.sh）

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

mc_load_config

LABEL="${MC_LABEL:-local.mac-cleanup}"
# 季度触发的「日」：1-28（29-31 在 2 月不存在，会静默永不触发）
SCHEDULE_DAY="${MC_SCHEDULE_DAY:-1}"
case "${SCHEDULE_DAY}" in
  ''|*[!0-9]*)
    printf 'ERROR: MC_SCHEDULE_DAY 必须是数字，当前=%s\n' "${SCHEDULE_DAY}" >&2
    exit 1
    ;;
esac
if [ "${SCHEDULE_DAY}" -lt 1 ] || [ "${SCHEDULE_DAY}" -gt 28 ]; then
  printf 'ERROR: MC_SCHEDULE_DAY 必须在 1-28 之间（当前 %s）—— 29-31 日在 2 月不存在，任务会静默不触发\n' "${SCHEDULE_DAY}" >&2
  exit 1
fi
# 安装来源：npm 形态下由 --install 把包复制到 ~/.mac-cleanup/app 再传进来
APP_DIR="${MC_APP_DIR:-${MC_ROOT}}"
TEMPLATE="${MC_ROOT}/deploy/launchd.plist.template"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${MC_REPORT_DIR}"
DOMAIN="gui/$(id -u)"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

render_plist() {
  [ -f "${TEMPLATE}" ] || die "模板不存在：${TEMPLATE}"
  sed -e "s|__LABEL__|${LABEL}|g" \
      -e "s|__PROJECT_DIR__|${APP_DIR}|g" \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__LOG_DIR__|${LOG_DIR}|g" \
      -e "s|__DAY__|${SCHEDULE_DAY}|g" \
      "${TEMPLATE}"
}

case "${1:-}" in
  --uninstall)
    say "卸载 ${LABEL} …"
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    rm -f "${TARGET}" && say "  已删除 ${TARGET}"
    if [ -d "${MC_STATE_DIR}/app" ]; then
      rm -rf "${MC_STATE_DIR}/app" && say "  已删除运行副本 ${MC_STATE_DIR}/app"
    fi
    say "  报告与日志保留在 ${LOG_DIR}"
    exit 0
    ;;

  --status)
    say "label  : ${LABEL}"
    say "plist  : ${TARGET} $( [ -f "${TARGET}" ] && echo '(存在)' || echo '(不存在)' )"
    say "--- launchctl ---"
    launchctl print "${DOMAIN}/${LABEL}" 2>&1 | sed -n '1,6p;/next fire/p' || true
    say "--- 最近报告 ---"
    ls -1t "${LOG_DIR}"/*.md 2>/dev/null | head -3 || say "  （还没有报告）"
    exit 0
    ;;

  --run-now)
    launchctl kickstart -k "${DOMAIN}/${LABEL}" 2>&1 || die "kickstart 失败（先 ./install.sh 安装）"
    say "已触发。看 ${LOG_DIR}/launchd.out.log"
    exit 0
    ;;

  --dry-run)
    say "将要写入 ${TARGET} 的内容："
    say "────────────────────────────────────────"
    render_plist
    exit 0
    ;;

  "" ) ;;
  *) die "未知参数：$1（见文件头注释）" ;;
esac

# ── 安装 ──────────────────────────────────────────────────────
[ -f "${MC_CONFIG_LOCAL}" ] || die "还没初始化。先跑：mac-cleanup --init（或 ${MC_ROOT}/mac-cleanup.sh --init）"
[ -f "${MC_REF_WHITELIST}" ] || die "缺少 whitelist.reference。先跑：${MC_ROOT}/mac-cleanup.sh --init"
[ -x "${MC_ROOT}/mac-cleanup.sh" ] || chmod +x "${MC_ROOT}/mac-cleanup.sh" 2>/dev/null || true
[ -f "${TEMPLATE}" ] || die "模板不存在：${TEMPLATE}"

MO_BIN="$(detect_mo_bin)" || die "找不到 mo（先 brew install mole）"
say "mo: ${MO_BIN}"

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

# 已存在就先卸掉旧的，避免 bootstrap 报 "already loaded"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

render_plist > "${TARGET}" || die "写 plist 失败"
plutil -lint "${TARGET}" > /dev/null || die "plist 语法错误：${TARGET}"

launchctl bootstrap "${DOMAIN}" "${TARGET}" || die "bootstrap 失败"
launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true

say "✅ 已安装：${TARGET}"
say "   触发时间：1/4/7/10 月 ${SCHEDULE_DAY} 日 10:00（睡眠时顺延到唤醒后）"
say "   日志：${LOG_DIR}/launchd.out.log"
say "   报告：${LOG_DIR}/<年>-Q<季>.md"
say
say "先手动验证一次（不删东西）："
say "   ${MC_ROOT}/mac-cleanup.sh --check"
