#!/bin/bash
# 安装 / 卸载季度清理的 LaunchAgent
#
#   ./install.sh             安装（生成 plist → 写入 ~/Library/LaunchAgents → 注册到 launchd）
#   ./install.sh --status    查看当前状态与下次运行时间
#   ./install.sh --run-now   立刻跑一次（调试用）
#   ./install.sh --uninstall 卸载
#   ./install.sh --dry-run   只打印将要生成的 plist，不写任何文件

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.wangying.mac-cleanup"
TEMPLATE="${PROJECT_DIR}/launchd/${LABEL}.plist.template"
TARGET="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/mac-cleanup"
DOMAIN="gui/$(id -u)"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

render_plist() {
  [ -f "${TEMPLATE}" ] || die "模板不存在：${TEMPLATE}"
  sed -e "s|__LABEL__|${LABEL}|g" \
      -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__LOG_DIR__|${LOG_DIR}|g" \
      "${TEMPLATE}"
}

case "${1:-}" in
  --uninstall)
    say "卸载 ${LABEL} …"
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    rm -f "${TARGET}" && say "  已删除 ${TARGET}"
    say "  报告与日志保留在 ${LOG_DIR}"
    exit 0
    ;;

  --status)
    say "plist : ${TARGET} $( [ -f "${TARGET}" ] && echo '(存在)' || echo '(不存在)' )"
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
  *) die "未知参数：$1" ;;
esac

# ── 安装 ──────────────────────────────────────────────────────
[ -x "${PROJECT_DIR}/mac-cleanup.sh" ] || chmod +x "${PROJECT_DIR}/mac-cleanup.sh" 2>/dev/null || true
[ -f "${TEMPLATE}" ] || die "模板不存在：${TEMPLATE}"
command -v mo > /dev/null 2>&1 || [ -x /opt/homebrew/bin/mo ] || die "找不到 mo（先 brew install mole）"

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

# 已存在就先卸掉旧的，避免 bootstrap 报 "already loaded"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

render_plist > "${TARGET}" || die "写 plist 失败"
plutil -lint "${TARGET}" > /dev/null || die "plist 语法错误：${TARGET}"

launchctl bootstrap "${DOMAIN}" "${TARGET}" || die "bootstrap 失败"
launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true

say "✅ 已安装：${TARGET}"
say "   触发时间：1/4/7/10 月 1 日 10:00（睡眠时会顺延到唤醒后）"
say "   日志：${LOG_DIR}/launchd.out.log"
say "   报告：${LOG_DIR}/<年>-Q<季>.md"
say
say "先手动验证一次（不删东西）："
say "   ${PROJECT_DIR}/mac-cleanup.sh --check"
