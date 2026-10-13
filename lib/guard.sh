#!/bin/bash
# 白名单体检 —— 这是整个脚本里最重要的一道护栏
#
# 为什么必须有：
#   1. Mole 的白名单是【替换】语义（1.7.5+）：~/.config/mole/whitelist 一旦存在，
#      内置那 19 条保护就全靠这个文件了。少写一条 = 静默失去一条保护。
#   2. 条目写错父目录（如把 Caches/x 写成 "Application Support/x"）不会报错，
#      只是永远不会命中 —— 静默的洞。2026-10 就因此丢过 1.13GB 的目录。
#
# 判定：
#   FAIL → 调用方必须中止，绝不清
#   WARN → 只提示，不影响执行

# 允许"当前不存在"的条目（已删除 / 尚未创建），不算问题
KNOWN_MAYBE_ABSENT="
${HOME}/Library/Caches/com.tencent.workbuddy.mac.BundleMigration
${HOME}/Library/Caches/Doubao
${HOME}/Library/Caches/DoubaoWork
${HOME}/Library/Application Support/Google/Chrome/Default/Service Worker
"

_norm() {  # ~ 展开 + 去首尾空白
  local l="$1"
  l="${l#"${l%%[![:space:]]*}"}"
  l="${l%"${l##*[![:space:]]}"}"
  case "${l}" in
    "~/"*) l="${HOME}/${l#\~/}" ;;
    "~")   l="${HOME}" ;;
  esac
  printf '%s' "${l}"
}

_read_patterns() {  # 读文件里所有有效条目（跳过空行和 # 注释）
  local f="$1"
  [ -f "${f}" ] || return 0
  while IFS= read -r line; do
    line="$(_norm "${line}")"
    case "${line}" in ""|\#*) continue ;; esac
    printf '%s\n' "${line}"
  done < "${f}"
}

# 从已安装的 Mole 里提取内置模式（best-effort；提取不到不算错）
_mole_builtin_patterns() {
  local base=""
  for c in /opt/homebrew/Cellar/mole/*/libexec/lib/core/base.sh; do
    [ -f "${c}" ] && base="${c}"
  done
  [ -n "${base}" ] || return 0
  awk '
    /^declare -a (DEFAULT|SAFETY)_WHITELIST_PATTERNS=\(/ { inarr = 1; next }
    inarr && /^\)/ { inarr = 0; next }
    inarr {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      sub(/[[:space:]]*$/, "", line)
      if (line ~ /^"/) {
        gsub(/^"|"$/, "", line)
        gsub(/\$HOME/, ENVIRON["HOME"], line)
        if (line ~ /\$/) next                    # 跳过 $FINDER_METADATA_SENTINEL 这类哨兵
        print line
      }
    }
  ' "${base}"
}

# guard_whitelist <reference_file> <live_file>
guard_whitelist() {
  local ref="$1" live="$2"
  local fail=0 warn=0
  local n_ref=0 n_live=0

  echo "reference: ${ref}"
  echo "live     : ${live}"
  echo

  if [ ! -f "${live}" ]; then
    echo "FAIL  白名单文件不存在：${live}"
    echo "      → Mole 会退回使用内置默认 19 条（此时反而安全）"
    echo "      → 但如果这不是你想要的，请先恢复：cp ${ref} ${live}"
    echo "VERDICT: FAIL"
    return 1
  fi

  local live_list; live_list="$(mktemp -t maccleanup-live.XXXXXX)"
  local ref_list;  ref_list="$(mktemp -t maccleanup-ref.XXXXXX)"
  local bi_list;   bi_list="$(mktemp -t maccleanup-bi.XXXXXX)"
  _read_patterns "${live}" > "${live_list}"
  _read_patterns "${ref}"  > "${ref_list}"
  _mole_builtin_patterns  > "${bi_list}"
  n_live="$(wc -l < "${live_list}" | tr -d ' ')"
  n_ref="$(wc -l < "${ref_list}" | tr -d ' ')"

  echo "条目数：live=${n_live}  reference=${n_ref}  内置提取=$([ -s "${bi_list}" ] && wc -l < "${bi_list}" | tr -d ' ' || echo 0)"
  echo

  # ① 基准清单里每一条都必须在 live 里
  local p
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    grep -Fxq "${p}" "${live_list}" || {
      echo "FAIL  reference 有、live 没有：${p}"
      fail=$((fail + 1))
    }
  done < "${ref_list}"

  # ② 内置保护也必须都在（best-effort）
  if [ -s "${bi_list}" ]; then
    while IFS= read -r p; do
      [ -n "${p}" ] || continue
      grep -Fxq "${p}" "${live_list}" || {
        echo "FAIL  内置保护缺失：${p}"
        fail=$((fail + 1))
      }
    done < "${bi_list}"
  else
    echo "WARN  无法从已安装的 Mole 提取内置模式（版本不匹配？）—— 跳过②，仅靠基准清单兜底"
    warn=$((warn + 1))
  fi

  # ③ 空条目检查：live 里【我们自己加的】条目，是否命中得到真实路径
  #    内置默认（bi_list）不参与 —— 那是跨用户通用的，本机没装 Gradle/Ollama/JetBrains
  #    之类本来就会"不存在"，报出来全是噪音。这道检查只为了抓"我们写错父目录"。
  local pm
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    if [ -s "${bi_list}" ] && grep -Fxq "${p}" "${bi_list}"; then
      continue
    fi
    case "${p}" in
      *\**|*\?*|*\[*)
        # 通配条目：用 glob 展开看看有没有命中
        # shellcheck disable=SC2086
        if ! compgen -G "${p}" > /dev/null 2>&1; then
          case "${KNOWN_MAYBE_ABSENT}" in
            *"${p}"*) : ;;
            *) echo "WARN  条目命中不到任何路径（可能写错了父目录？）：${p}"; warn=$((warn + 1)) ;;
          esac
        fi
        ;;
      *)
        if [ ! -e "${p}" ]; then
          case "${KNOWN_MAYBE_ABSENT}" in
            *"${p}"*) : ;;
            *) echo "WARN  条目命中不到任何路径（可能写错了父目录？）：${p}"; warn=$((warn + 1)) ;;
          esac
        fi
        ;;
    esac
  done < "${live_list}"

  rm -f "${live_list}" "${ref_list}" "${bi_list}"

  echo
  if [ "${fail}" -gt 0 ]; then
    echo "共 ${fail} 条 FAIL / ${warn} 条 WARN"
    echo "VERDICT: FAIL"
    return 1
  fi
  echo "0 条 FAIL / ${warn} 条 WARN"
  echo "VERDICT: PASS"
  return 0
}
