#!/bin/bash
# 白名单体检 —— 整个脚本里最重要的一道护栏
#
# 为什么必须有：
#   1. Mole 的白名单是【替换】语义（1.7.5+）：~/.config/mole/whitelist 一旦存在，
#      内置保护就全靠这个文件。少写一条 = 静默失去一条保护。
#   2. 条目写错父目录（把 Caches/x 写成 "Application Support/x"）不会报错，
#      只是永远不命中 —— 静默的洞。2026-10 真因此丢过 1.13GB 的目录。
#
# 判定：
#   FAIL → 调用方必须中止，绝不清
#   WARN → 只提示，不影响执行
#
# 本文件不含任何本机专属路径：
#   基准清单  = whitelist.reference（--init 生成）
#   允许缺失  = expect-absent.list（--init 生成）
#   内置保护  = 从已安装 Mole 的源码动态提取（detect.sh）

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

# 该条目是否在"允许缺失"清单里
_is_expect_absent() {
  local p="$1" f="${MC_EXPECT_ABSENT:-}"
  [ -n "${f}" ] && [ -f "${f}" ] || return 1
  grep -Fxq "$(printf '%s' "${p}" | sed "s|${HOME}|~|")" "${f}" 2>/dev/null || \
  grep -Fxq "${p}" "${f}" 2>/dev/null
}

# guard_whitelist <reference_file> <live_file>
guard_whitelist() {
  local ref="$1" live="$2"
  local fail=0 warn=0

  echo "reference: ${ref}"
  echo "live     : ${live}"
  echo

  if [ ! -f "${live}" ]; then
    echo "FAIL  白名单文件不存在：${live}"
    echo "      → Mole 会退回使用自己的内置默认（此时反而安全）"
    echo "      → 想用本项目的基准：cp ${ref} ${live}"
    echo "VERDICT: FAIL"
    return 1
  fi

  local live_list ref_list bi_list
  live_list="$(mktemp -t maccleanup-live.XXXXXX)"
  ref_list="$(mktemp -t maccleanup-ref.XXXXXX)"
  bi_list="$(mktemp -t maccleanup-bi.XXXXXX)"
  _read_patterns "${live}" > "${live_list}"
  _read_patterns "${ref}"  > "${ref_list}"
  mole_builtin_patterns    > "${bi_list}"

  local n_live n_ref n_bi
  n_live="$(wc -l < "${live_list}" | tr -d ' ')"
  n_ref="$(wc -l < "${ref_list}" | tr -d ' ')"
  n_bi="$([ -s "${bi_list}" ] && wc -l < "${bi_list}" | tr -d ' ' || echo 0)"
  echo "条目数：live=${n_live}  reference=${n_ref}  内置提取=${n_bi}"
  echo

  # ① 基准清单里每一条都必须在 live 里
  local p
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    grep -Fxq "${p}" "${live_list}" || {
      echo "FAIL  reference 有、live 没有：$(printf '%s' "${p}" | sed "s|${HOME}|~|")"
      fail=$((fail + 1))
    }
  done < "${ref_list}"

  # ② 内置保护也必须都在（best-effort；Mole 版本差异时降级为 WARN）
  if [ -s "${bi_list}" ]; then
    while IFS= read -r p; do
      [ -n "${p}" ] || continue
      grep -Fxq "${p}" "${live_list}" || {
        echo "FAIL  内置保护缺失：$(printf '%s' "${p}" | sed "s|${HOME}|~|")"
        fail=$((fail + 1))
      }
    done < "${bi_list}"
  else
    echo "WARN  无法从已安装的 Mole 提取内置模式（版本不匹配？）—— 跳过②，仅靠基准清单兜底"
    warn=$((warn + 1))
  fi

  # ③ 空条目检查：live 里【非内置】的条目，是否命中得到真实路径
  #    内置默认不参与 —— 那是跨用户通用的，本机没装 Gradle/Ollama 之类本来就不存在。
  #    这道检查只为抓"我们自己写错父目录"，以及"基准里过时的条目"。
  while IFS= read -r p; do
    [ -n "${p}" ] || continue
    if [ -s "${bi_list}" ] && grep -Fxq "${p}" "${bi_list}"; then
      continue
    fi
    if [ -e "${p}" ]; then
      continue
    fi
    case "${p}" in
      *\**|*\?*|*\[*)
        compgen -G "${p}" > /dev/null 2>&1 && continue
        ;;
    esac
    if _is_expect_absent "${p}"; then
      continue
    fi
    echo "WARN  条目命中不到任何路径（写错父目录？或已过时）：$(printf '%s' "${p}" | sed "s|${HOME}|~|")"
    warn=$((warn + 1))
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
