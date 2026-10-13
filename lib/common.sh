#!/bin/bash
# 共用：路径、日志、单位换算、报告生成
# 兼容 macOS 自带的 bash 3.2（不用关联数组）

# ── 固定路径（launchd 环境下 PATH 极简，一律用绝对路径）──────────
readonly MO_BIN="/opt/homebrew/bin/mo"
readonly MOLE_HOME="${HOME}/.config/mole"
readonly MOLE_WHITELIST="${MOLE_HOME}/whitelist"
readonly MOLE_LOG="${HOME}/Library/Logs/mole/operations.log"
readonly CLEAN_LIST="${MOLE_HOME}/clean-list.txt"
readonly REPORT_DIR="${HOME}/Library/Logs/mac-cleanup"
readonly WORK_DIR="${REPORT_DIR}/work"

# 必须存在的关键资产：缺了就是 BROKEN（这些是本机确实有的东西）
# 格式：<路径>|<说明>
readonly CRITICAL_ASSETS="
${HOME}/.npm/_npx/1e7f6d9597241db0|DSH 运行时（~/.dsh/profiles/node_modules 下 164 个符号链接指向它）
${HOME}/.dsh/profiles|DSH 配置与其 node_modules 符号链接
${HOME}/.dsh|DSH 配置根目录
"

# 只观察、不判失败的资产：本机没装就是没有，报出来只是噪音
readonly WATCH_ASSETS="
${HOME}/.ollama/models|本地模型（重下几十 GB）
${HOME}/Library/Mobile Documents|iCloud Drive
${HOME}/Library/Application Support/JetBrains|JetBrains IDE 配置
${HOME}/.gradle/caches|Gradle 依赖缓存
"

log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] WARN  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
err()  { printf '[%s] ERROR %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

# 根卷可用空间（KB）
free_kb() { df -k / 2>/dev/null | awk 'NR==2{print $4}'; }

# KB → 人类可读
kb_human() {
  awk -v k="${1:-0}" 'BEGIN{
    split("KB MB GB TB", u, " "); i=1
    while (k >= 1024 && i < 4) { k = k / 1024; i++ }
    printf (i==1 ? "%d %s" : "%.2f %s"), k, u[i]
  }'
}

# 把 "661.4MB" / "1.2GB" / "38KB" / "8B" 累加，输出 KB
_human_to_kb() {
  awk 'BEGIN{
    split("B KB MB GB TB", u, " ")
    m = 1
    for (i = 1; i <= 5; i++) if (unit == u[i]) { for (j = 1; j < i; j++) m *= 1024; break }
    printf "%.0f", num * m / 1024
  }' num="$1" unit="$2"
}

# clean-list.txt 里所有条目体积合计（人类可读）
pending_total_human() {
  local f="$1"
  [ -f "$f" ] || { echo "（无清单）"; return; }
  local kb
  kb="$(awk '
    {
      if (match($0, /# *[0-9.]+ *(B|KB|MB|GB) *$/)) {
        s = substr($0, RSTART + 1); gsub(/[ #()]/, "", s)
        unit = s; sub(/^[0-9.]+/, "", unit)
        num  = s; sub(/[A-Za-z]+$/, "", num)
        split("B KB MB GB TB", u, " "); m = 1
        for (i = 1; i <= 5; i++) if (unit == u[i]) { for (j = 1; j < i; j++) m *= 1024; break }
        total += num * m
      }
    }
    END { printf "%.0f", total / 1024 }
  ' "$f")"
  kb_human "${kb:-0}"
}

# ── 报告 ───────────────────────────────────────────────────────
# write_report <file> <quarter> <stamp> <status> <free_before_kb> <free_after_kb>
#              <guard> <dry_total> <mo_summary> <run_dir> [verify] [health]
write_report() {
  local file="$1" quarter="$2" stamp="$3" status="$4"
  local fb="$5" fa="$6" guard="$7" dry="$8" mosum="$9"
  local rundir="${10:-}" verify="${11:-未跑}" health="${12:-未跑}"
  local delta=$(( fa - fb ))

  mkdir -p "$(dirname "${file}")" 2>/dev/null || true

  {
    echo "# Mac 清理报告 — ${quarter}"
    echo
    echo "> 运行时间：${stamp}　状态：**${status}**"
    echo
    echo "## 结果"
    echo
    echo "| 项 | 值 |"
    echo "|---|---|"
    echo "| 清理前可用 | $(kb_human "${fb}") |"
    echo "| 清理后可用 | $(kb_human "${fa}") |"
    case "${status}" in
      CHECK-ONLY|ABORTED) echo "| **实际释放** | —（本次未清理） |" ;;
      *)                  echo "| **实际释放** | **$(kb_human "${delta}")** |" ;;
    esac
    echo "| 白名单体检 | ${guard} |"
    echo "| 结果核对 | ${verify} |"
    echo "| 关键资产体检 | ${health} |"
    echo "| dry-run 预计 | ${dry} |"
    echo
    echo "## Mole 自报（⚠️ 不可信，仅供对照）"
    echo
    echo '```'
    echo "${mosum:-（无）}"
    echo '```'
    echo
    echo "Mole 的 \`Tracked cleanup\` 历史上出现过：少报 3.4 倍、虚报 2275MB。"
    echo "**以「实际释放」列为准。**"
    echo
    echo "## 产物"
    echo
    echo "- 运行目录：\`${rundir}\`"
    echo "  - \`guard.txt\` 白名单体检明细"
    echo "  - \`dry-run.txt\` / \`clean-list.txt\` 本次预演清单"
    echo "  - \`clean.txt\` mo clean 原始输出"
    echo "  - \`verify.txt\` 日志加总核对"
    echo "  - \`health.txt\` 关键资产体检"
    echo
    echo "## 需要人看的情况"
    echo
    echo "只有出现下面任意一条才需要介入（否则本次可以不管）："
    echo
    echo "- 白名单体检 **FAIL** → 已经中止，没清任何东西，去补白名单"
    echo "- 结果核对 **MISMATCH** → 去看 \`verify.txt\`"
    echo "- 关键资产体检 **BROKEN/MISSING** → 立刻处理（可能影响 DSH / IDE / iCloud）"
    echo "- dry-run 清单里出现从未见过的大目录 → 下次清理前手动看一眼"
    echo
  } > "${file}"
}
