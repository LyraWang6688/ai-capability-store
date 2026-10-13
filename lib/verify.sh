#!/bin/bash
# 核对 + 体检
#
# 为什么不信 Mole 的汇总（实测两次）：
#   2026-10-04 第 2 轮：汇总 Tracked 1.67GB / 495 items，日志实测 1.64GB / 707 REMOVED → 基本吻合
#   2026-10-04 第 3 轮：汇总 Tracked 10.43GB / 161 items，日志实测 35.83GB / 426 REMOVED → 少报 3.4 倍
#   2026-10-04 第 2 轮另一处：汇总 "Cleaned 1 items, about 2275MB"，实际是 SKIPPED，文件还在 → 虚报
#
# 结论：只认 operations.log 的逐条加总 + df 实测。
# 单位说明：Mole 的显示是十进制（GB=10^9），此处按同样口径解析，避免 5% 系统性偏差。

_parse_size_to_bytes() {  # "62.1MB" → bytes（十进制）
  awk -v s="${1}" 'BEGIN{
    unit = s; sub(/^[0-9.]+/, "", unit)
    num  = s; sub(/[A-Za-z]+$/, "", num)
    m = 1
    if (unit == "KB") m = 1000
    else if (unit == "MB") m = 1000000
    else if (unit == "GB") m = 1000000000
    else if (unit == "TB") m = 1000000000000
    printf "%.0f", num * m
  }'
}

_bytes_human() {
  awk -v b="${1:-0}" 'BEGIN{
    if (b >= 1000000000) printf "%.2f GB", b/1000000000
    else if (b >= 1000000) printf "%.1f MB", b/1000000
    else if (b >= 1000) printf "%.0f KB", b/1000
    else printf "%d B", b
  }'
}

# verify_clean <logfile> <since_ts> <free_before_kb> <free_after_kb>
verify_clean() {
  local logf="$1" since="$2" fb="$3" fa="$4"

  if [ ! -f "${logf}" ]; then
    echo "MISMATCH 日志文件不存在：${logf}"
    echo "VERDICT: MISMATCH"
    return 1
  fi

  # 取最后一次 session（最后一次 "clean session started" 之后的内容）
  local start_line
  start_line="$(grep -n 'clean session started at' "${logf}" | tail -1 | cut -d: -f1)"
  [ -n "${start_line}" ] || start_line=1

  local stats
  stats="$(tail -n +"${start_line}" "${logf}" | awk '
    BEGIN { rem_items = 0; rem_bytes = 0; skip = 0; fail = 0; mo_items = ""; mo_gb = "" }
    function tobytes(s,   unit, num, m) {
      unit = s; sub(/^[0-9.]+/, "", unit)
      num  = s; sub(/[A-Za-z]+$/, "", num)
      m = 1
      if (unit == "KB") m = 1000
      else if (unit == "MB") m = 1000000
      else if (unit == "GB") m = 1000000000
      else if (unit == "TB") m = 1000000000000
      return num * m
    }
    /clean session ended at/ {
      # 形如: ... ended at 2026-10-04 01:43:10, 428 items, 36.72GB ==========
      if (match($0, /, [0-9]+ items/)) {
        s = substr($0, RSTART + 2); sub(/ items.*/, "", s); mo_items = s
      }
      if (match($0, /, [0-9.]+ *GB/)) {
        s = substr($0, RSTART + 2); sub(/ *GB.*/, "", s); mo_gb = s
      }
    }
    /\[clean\] REMOVED/ {
      rem_items++
      if (match($0, /\([0-9.]+ *(B|KB|MB|GB|TB)\)[[:space:]]*$/)) {
        s = substr($0, RSTART + 1, RLENGTH - 2)   # 去掉括号
        rem_bytes += tobytes(s)
      }
      next
    }
    /\[clean\] SKIPPED/ { skip++; next }
    /\[clean\] FAILED/  { fail++; next }
    END {
      printf "rem_items=%d\nrem_bytes=%.0f\nskip=%d\nfail=%d\nmo_items=%s\nmo_gb=%s\n",
             rem_items, rem_bytes, skip, fail, mo_items, mo_gb
    }
  ')"

  local rem_items rem_bytes skip fail mo_items mo_gb
  rem_items="$(printf '%s\n' "${stats}" | sed -n 's/^rem_items=//p')"
  rem_bytes="$(printf '%s\n' "${stats}" | sed -n 's/^rem_bytes=//p')"
  skip="$(printf '%s\n' "${stats}" | sed -n 's/^skip=//p')"
  fail="$(printf '%s\n' "${stats}" | sed -n 's/^fail=//p')"
  mo_items="$(printf '%s\n' "${stats}" | sed -n 's/^mo_items=//p')"
  mo_gb="$(printf '%s\n' "${stats}" | sed -n 's/^mo_gb=//p')"

  local df_delta_kb=$(( fa - fb ))
  local df_delta_bytes=$(( df_delta_kb * 1024 ))
  local mo_bytes=0
  [ -n "${mo_gb}" ] && mo_bytes="$(_parse_size_to_bytes "${mo_gb}GB")"

  echo "REMOVED   ${rem_items} 项 / $(_bytes_human "${rem_bytes}")（逐条加总，权威）"
  echo "MOLE_SAID ${mo_items:-?} 项 / ${mo_gb:-?} GB（Mole 自报，仅对照）"
  echo "DF_DELTA  根卷实际变化 $(_bytes_human "${df_delta_bytes}")"
  echo "SKIPPED   ${skip} 项（受保护，正常）"
  echo "FAILED    ${fail} 项（权限/占用，无损）"

  # 判定：Mole 自报 vs 日志加总，体积偏差 > 20% 视为 MISMATCH
  local verdict="OK" reason=""
  if [ -n "${mo_gb}" ] && [ "${mo_bytes}" -gt 0 ]; then
    local diff
    diff="$(awk -v a="${mo_bytes}" -v b="${rem_bytes}" 'BEGIN{
      d = (a > b) ? (a - b) : (b - a)
      printf "%.0f", (b > 0) ? d * 100 / b : 0
    }')"
    if [ "${diff}" -gt 20 ]; then
      verdict="MISMATCH"
      reason="Mole 自报与日志加总偏差 ${diff}%（> 20%）"
    fi
  fi

  # 次要判定：df 实际变化 vs 日志加总，偏差 > 40% 时提示（APFS 回收/其它进程会干扰）
  if [ "${verdict}" = "OK" ] && [ "${df_delta_bytes}" -gt 0 ]; then
    local d2
    d2="$(awk -v a="${df_delta_bytes}" -v b="${rem_bytes}" 'BEGIN{
      d = (a > b) ? (a - b) : (b - a)
      printf "%.0f", (b > 0) ? d * 100 / b : 0
    }')"
    [ "${d2}" -gt 40 ] && reason="注：df 变化与日志加总差 ${d2}%（APFS 回收/其它进程可能导致，正常范围可忽略）"
  fi

  [ -n "${reason}" ] && echo "MISMATCH ${reason}"
  echo "VERDICT: ${verdict}"
  [ "${verdict}" = "OK" ]
}

# health_check —— 关键资产体检
health_check() {
  local broken=0 missing=0

  # ① DSH profile 的符号链接完整性（最能说明问题的一条）
  local link_total=0 link_ok=0 link_bad=0 bad_names=""
  local l
  for l in "${HOME}"/.dsh/profiles/node_modules/*; do
    [ -L "${l}" ] || continue
    link_total=$((link_total + 1))
    if [ -e "${l}" ]; then
      link_ok=$((link_ok + 1))
    else
      link_bad=$((link_bad + 1))
      bad_names="${bad_names} $(basename "${l}")"
    fi
  done
  if [ "${link_total}" -gt 0 ]; then
    if [ "${link_bad}" -gt 0 ]; then
      echo "BROKEN  DSH 符号链接 ${link_bad}/${link_total} 悬空 →${bad_names}"
      broken=$((broken + 1))
    else
      echo "OK      DSH 符号链接 ${link_ok}/${link_total} 全部有效"
    fi
  else
    echo "OK      DSH 符号链接（未发现，跳过）"
  fi

  # ② 必须存在的关键资产
  local tmp="${TMPDIR:-/tmp}/maccleanup-health.$$"
  local entry path desc
  printf '%s\n' "${CRITICAL_ASSETS}" | while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    path="${entry%%|*}"
    desc="${entry#*|}"
    if [ -e "${path}" ]; then
      echo "OK      存在：${path}　（${desc}）"
    else
      echo "MISSING 缺失：${path}　（${desc}）"
    fi
  done > "${tmp}"
  cat "${tmp}"
  missing="$(grep -c '^MISSING' "${tmp}" 2>/dev/null || true)"
  missing="${missing:-0}"

  # ②b 只观察的资产（本机没装就是没有，不算失败）
  printf '%s\n' "${WATCH_ASSETS}" | while IFS= read -r entry; do
    [ -n "${entry}" ] || continue
    path="${entry%%|*}"
    desc="${entry#*|}"
    if [ -e "${path}" ]; then
      echo "OK      在：${path}　（${desc}）"
    else
      echo "ABSENT  本机无：${path}　（${desc}）"
    fi
  done
  rm -f "${tmp}"

  # ③ 白名单里的"必保"条目顺手确认一遍（注意白名单里存的是 ~/ 形式）
  if [ -f "${MOLE_WHITELIST}" ]; then
    if grep -Fq '~/.npm/_npx/1e7f6d9597241db0' "${MOLE_WHITELIST}" ||
       grep -Fq "${HOME}/.npm/_npx/1e7f6d9597241db0" "${MOLE_WHITELIST}"; then
      echo "OK      DSH 运行时目录在保护名单里"
    else
      echo "MISSING DSH 运行时目录不在保护名单里（危险：下次清理会删掉它）"
      missing=$((missing + 1))
    fi
  fi

  echo
  if [ "${broken}" -gt 0 ] || [ "${missing}" -gt 0 ]; then
    echo "VERDICT: BROKEN"
    return 1
  fi
  echo "VERDICT: OK"
  return 0
}
