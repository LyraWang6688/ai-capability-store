#!/bin/bash
# 共用：配置加载、日志、单位换算、报告生成
# 兼容 macOS 自带的 bash 3.2（不用关联数组）
#
# 设计目标：这个文件里【不许出现任何本机专属路径】。
# 本机相关的一切由 --init 生成到生成的清单文件里（见 detect.sh / init.sh）。

MC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 默认配置（可提交）────────────────────────────────────────
readonly MC_CONFIG_DEFAULT="${MC_ROOT}/config.default.sh"
# ── 本机配置（--init 生成，gitignore）────────────────────────
readonly MC_CONFIG_LOCAL="${MC_ROOT}/config.local.sh"

# ── 生成的清单文件（--init 生成，gitignore）──────────────────
readonly MC_REF_WHITELIST="${MC_ROOT}/whitelist.reference"
readonly MC_EXPECT_ABSENT="${MC_ROOT}/expect-absent.list"
readonly MC_CRITICAL_LIST="${MC_ROOT}/critical.list"
readonly MC_WATCH_LIST="${MC_ROOT}/watch.list"

# ── Mole 自己的路径（Mole 的约定，跨机器一致）────────────────
readonly MC_MOLE_HOME="${HOME}/.config/mole"
readonly MC_MOLE_WHITELIST="${MC_MOLE_HOME}/whitelist"
readonly MC_MOLE_LOG="${HOME}/Library/Logs/mole/operations.log"
readonly MC_CLEAN_LIST="${MC_MOLE_HOME}/clean-list.txt"

# ── 配置项默认值（config.local.sh 可覆盖）────────────────────
MC_MO_BIN=""
MC_LABEL="local.mac-cleanup"
MC_REPORT_DIR="${HOME}/Library/Logs/mac-cleanup"
MC_DSH_RUNTIME=""          # 由 --init 探测；空 = 不做 DSH 相关检查
MC_DSH_HOME=""             # 同上

mc_load_config() {
  if [ -f "${MC_CONFIG_DEFAULT}" ]; then
    # shellcheck disable=SC1090
    . "${MC_CONFIG_DEFAULT}"
  fi
  if [ -f "${MC_CONFIG_LOCAL}" ]; then
    # shellcheck disable=SC1090
    . "${MC_CONFIG_LOCAL}"
  fi
  MC_WORK_DIR="${MC_REPORT_DIR}/work"
}

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

# 读一个 `path|desc` 清单文件（跳过空行和 # 注释）
read_asset_list() {
  local f="$1"
  [ -f "${f}" ] || return 0
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "${line}" in ""|\#*) continue ;; esac
    printf '%s\n' "${line}"
  done < "${f}"
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
    echo "- 关键资产体检 **BROKEN/MISSING** → 立刻处理"
    echo "- dry-run 清单里出现从未见过的大目录 → 下次清理前手动看一眼"
    echo
  } > "${file}"
}
