#!/bin/bash
# 共用：配置加载、日志、单位换算、报告生成
# 兼容 macOS 自带的 bash 3.2（不用关联数组）
#
# 设计目标：这个文件里【不许出现任何本机专属路径】。
# 本机相关的一切由 --init 生成到生成的清单文件里（见 detect.sh / init.sh）。

MC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 状态目录（本机生成物）────────────────────────────────────
# 为什么不放包目录：npm/npx 把包装在缓存目录（~/.npm/_npx/<hash>/…），
# 那里随时被回收，而且是只读语义。所以状态一律放用户目录。
# 可用 MC_STATE_DIR 覆盖（测试用）。
readonly MC_STATE_DIR="${MC_STATE_DIR:-${HOME}/.mac-cleanup}"

# ── 默认配置（随包发布，只读）────────────────────────────────
readonly MC_CONFIG_DEFAULT="${MC_ROOT}/config.default.sh"
# ── 本机配置（--init 生成，落在状态目录）────────────────────
readonly MC_CONFIG_LOCAL="${MC_STATE_DIR}/config.local.sh"

# ── 生成的清单文件（--init 生成，落在状态目录）──────────────
readonly MC_REF_WHITELIST="${MC_STATE_DIR}/whitelist.reference"
readonly MC_EXPECT_ABSENT="${MC_STATE_DIR}/expect-absent.list"
readonly MC_CRITICAL_LIST="${MC_STATE_DIR}/critical.list"
readonly MC_WATCH_LIST="${MC_STATE_DIR}/watch.list"

# ── Mole 自己的路径（Mole 的约定，跨机器一致）────────────────
readonly MC_MOLE_HOME="${HOME}/.config/mole"
readonly MC_MOLE_WHITELIST="${MC_MOLE_HOME}/whitelist"
readonly MC_MOLE_LOG="${HOME}/Library/Logs/mole/operations.log"
readonly MC_CLEAN_LIST="${MC_MOLE_HOME}/clean-list.txt"

# ── 配置项默认值（config.local.sh 可覆盖）────────────────────
# 先把【真正的环境变量】快照下来，再填默认值。
# 否则默认值会被误当成"调用方传入的值"，在 mc_load_config 里反过来盖掉
# config.local.sh 的配置（0.2.2 就栽在这里：config 里的 MC_SCHEDULE_DAY 被
# 默认的 1 覆盖，日期永远生效不了）。
_MC_ENV_MO_BIN="${MC_MO_BIN:-}"
_MC_ENV_LABEL="${MC_LABEL:-}"
_MC_ENV_SCHEDULE_DAY="${MC_SCHEDULE_DAY:-}"
_MC_ENV_REPORT_DIR="${MC_REPORT_DIR:-}"

# 一律用 ${VAR:-默认}：这些是"默认值"，不是"强制值"。
MC_MO_BIN="${MC_MO_BIN:-}"
MC_LABEL="${MC_LABEL:-local.mac-cleanup}"
MC_SCHEDULE_DAY="${MC_SCHEDULE_DAY:-1}"
MC_REPORT_DIR="${MC_REPORT_DIR:-${HOME}/Library/Logs/mac-cleanup}"
MC_DSH_RUNTIME=""          # 由 --init 探测；空 = 不做 DSH 相关检查
MC_DSH_HOME=""             # 同上

mc_load_config() {
  # 环境变量优先于配置文件：配置文件里是硬赋值，会盖掉调用方的重定向（测试/临时改路径）
  # 用开头的快照，而不是当前值（当前值已被默认值填过）
  if [ -f "${MC_CONFIG_DEFAULT}" ]; then
    # shellcheck disable=SC1090
    . "${MC_CONFIG_DEFAULT}"
  fi
  if [ -f "${MC_CONFIG_LOCAL}" ]; then
    # shellcheck disable=SC1090
    . "${MC_CONFIG_LOCAL}"
  fi
  # 环境变量优先于配置文件（测试与临时覆盖靠它）
  [ -n "${_MC_ENV_REPORT_DIR}" ] && MC_REPORT_DIR="${_MC_ENV_REPORT_DIR}"
  [ -n "${_MC_ENV_SCHEDULE_DAY}" ] && MC_SCHEDULE_DAY="${_MC_ENV_SCHEDULE_DAY}"
  [ -n "${_MC_ENV_LABEL}" ] && MC_LABEL="${_MC_ENV_LABEL}"
  [ -n "${_MC_ENV_MO_BIN}" ] && MC_MO_BIN="${_MC_ENV_MO_BIN}"
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

# 从 Mole 的 clean-list.txt 取体积最大的 N 条，输出 "<bytes>\t<路径>"
# 为什么需要：dry-run 给出的是总数（如 26.5GB / 655 条），但真正决定
# "这次清理我要不要同意"的是最大的那几条 —— 比如废纸篓里 12GB 的旧备份。
top_pending_rows() {
  local f="$1" n="${2:-5}"
  [ -f "${f}" ] || return 0
  awk '
    {
      if (match($0, /# *[0-9.]+ *(B|KB|MB|GB) *$/)) {
        s = substr($0, RSTART + 1); gsub(/[ #()]/, "", s)
        unit = s; sub(/^[0-9.]+/, "", unit)
        num  = s; sub(/[A-Za-z]+$/, "", num)
        m = 1
        if (unit == "KB") m = 1024
        else if (unit == "MB") m = 1048576
        else if (unit == "GB") m = 1073741824
        path = $0
        sub(/[[:space:]]*#[^#]*$/, "", path)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", path)
        printf "%.0f\t%s\n", num * m, path
      }
    }
  ' "${f}" | sort -k1,1 -rn | head -n "${n}"
}

_bytes_human_dec() {  # 十进制展示（与 Mole 的 GB 口径一致）
  awk -v b="${1:-0}" 'BEGIN{
    if (b >= 1073741824) printf "%.2f GB", b/1073741824
    else if (b >= 1048576) printf "%.0f MB", b/1048576
    else printf "%.0f KB", b/1024
  }'
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

    # ── 待清理 Top 5：让"要删什么"直接可见，而不是藏在 655 行清单里 ──
    local cl="${rundir}/clean-list.txt"
    if [ -n "${rundir}" ] && [ -f "${cl}" ]; then
      local rows
      rows="$(top_pending_rows "${cl}" 5)"
      if [ -n "${rows}" ]; then
        echo "## 待清理 Top 5（按体积）"
        echo
        echo "| 体积 | 路径 |"
        echo "|---|---|"
        printf '%s\n' "${rows}" | while IFS="$(printf '\t')" read -r b p; do
          [ -n "${p}" ] || continue
          echo "| $(_bytes_human_dec "${b}") | \`$(printf '%s' "${p}" | sed "s|${HOME}|~|")\` |"
        done
        echo
        if printf '%s\n' "${rows}" | awk -F'\t' '($2 ~ /\/\.Trash\//) || ($1 + 0 >= 5368709120) { f = 1 } END { exit(f ? 0 : 1) }'; then
          echo "> ⚠️ 上面有项目落在**废纸篓**，或单项超过 5 GB。清理会真的删掉它们 —— "
          echo "> 确认不要了再跑完整清理；只是暂存的话先去废纸篓恢复。"
          echo
        fi
      fi
    fi

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
