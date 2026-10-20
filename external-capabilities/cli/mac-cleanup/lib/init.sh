#!/bin/bash
# --init：扫描本机，生成本机专属的配置与清单
#
# 生成物（全部 gitignore，不进版本控制）：
#   config.local.sh        本机标量配置（mo 路径、launchd label、报告目录、DSH 运行时）
#   whitelist.reference    本机白名单基准（内置保护 + 本机额外保护）
#   expect-absent.list     允许"命中不到路径"的条目（避免季度噪音）
#   critical.list          必须存在的关键资产
#   watch.list             只观察、不判失败的资产

# 判断一个白名单模式在磁盘上是否命中
_mc_pattern_hits() {
  local p="$1"
  case "${p}" in
    *\**|*\?*|*\[*)
      compgen -G "${p}" > /dev/null 2>&1
      ;;
    *)
      [ -e "${p}" ]
      ;;
  esac
}

_mc_backup_if_exists() {
  local f="$1"
  [ -f "${f}" ] || return 0
  local bak="${f}.bak-$(date '+%Y%m%d-%H%M%S')"
  cp "${f}" "${bak}" && printf '%s\n' "${bak}"
}

# run_init [--force]
run_init() {
  local force=0
  [ "${1:-}" = "--force" ] && force=1

  mkdir -p "${MC_STATE_DIR}" || { echo "✗ 无法创建状态目录 ${MC_STATE_DIR}"; return 1; }

  echo "════ mac-cleanup 初始化 ════"
  echo

  # ① mo
  local mo
  if ! mo="$(detect_mo_bin)"; then
    echo "✗ 找不到 mo。先装 Mole："
    echo "    brew install mole"
    echo "  或参考 https://github.com/tw93/Mole"
    return 1
  fi
  echo "✓ mo: ${mo}  (Mole $(mole_version))"

  # ② Mole 源码（用于提取内置白名单）
  local base n_builtin=0
  if base="$(detect_mole_base_sh)"; then
    n_builtin="$(mole_builtin_patterns | wc -l | tr -d ' ')"
    echo "✓ Mole 源码: ${base}"
    echo "  可提取内置保护 ${n_builtin} 条"
  else
    echo "⚠ 找不到 Mole 源码（只能靠基准清单兜底，护栏②会降级为 WARN）"
  fi

  # ③ DSH 运行时（可选）
  local dsh_runtime
  dsh_runtime="$(detect_dsh_runtime)"
  if [ -n "${dsh_runtime}" ]; then
    echo "✓ DSH 运行时: ${dsh_runtime}"
  else
    echo "· 没有检测到 DSH 运行时（不是 DSH 用户可忽略；相关检查会跳过）"
  fi

  # ④ 现有 Mole 白名单（可选）
  local live
  live="$(detect_live_whitelist)"
  if [ -n "${live}" ]; then
    echo "✓ 现有白名单: ${live}（$(( $(grep -vcE '^\s*(#|$)' "${live}") )) 条有效条目）"
  else
    echo "· 还没有 ~/.config/mole/whitelist（Mole 会用自己的内置默认，也是安全的）"
  fi
  echo

  # ── 写文件 ───────────────────────────────────────────────────
  local wrote=0 skipped=0
  _write_or_skip() {   # $1=path  $2=content
    local f="$1"
    if [ -f "${f}" ] && [ "${force}" -ne 1 ]; then
      echo "· 已存在，跳过：${f#"${MC_STATE_DIR}"/}（要重建加 --force）"
      skipped=$((skipped + 1))
      return 0
    fi
    if [ -f "${f}" ]; then
      local bak
      bak="$(_mc_backup_if_exists "${f}")"
      [ -n "${bak}" ] && echo "  备份：${bak#"${MC_STATE_DIR}"/}"
    fi
    printf '%s' "$2" > "${f}"
    echo "✓ 写入：${f#"${MC_STATE_DIR}"/}"
    wrote=$((wrote + 1))
  }

  # config.local.sh
  local user_label="local.mac-cleanup"
  _write_or_skip "${MC_CONFIG_LOCAL}" "# mac-cleanup 本机配置 —— 由 ./mac-cleanup.sh --init 生成
# 这个文件是本机专属的，不要提交到 git。

MC_MO_BIN=\"${mo}\"
MC_LABEL=\"${user_label}\"
MC_REPORT_DIR=\"\${HOME}/Library/Logs/mac-cleanup\"

# DSH 运行时目录（--init 探测）。空 = 不做 DSH 相关检查。
MC_DSH_RUNTIME=\"${dsh_runtime}\"
MC_DSH_HOME=\"$([ -d "${HOME}/.dsh" ] && printf '%s' "${HOME}/.dsh")\"
"

  # whitelist.reference = 内置保护 + DSH 运行时 + 现有白名单条目
  {
    echo "# mac-cleanup 白名单基准 —— 由 --init 生成"
    echo "# 语义：这里的每一条都必须在 ~/.config/mole/whitelist 里；"
    echo "#       你的实际白名单可以更多，但不能比这个少。"
    echo "#"
    echo "# 为什么必须有：Mole 1.7.5+ 的白名单是【替换】语义 ——"
    echo "#   该文件一旦存在，Mole 内置保护就全靠它，少一条 = 静默失去一条保护。"
    echo
    if [ -n "${base}" ]; then
      echo "# ── 以下由安装的 Mole 源码提取（内置保护）──"
      mole_builtin_patterns | sed "s|${HOME}|~|"
      echo
    fi
    if [ -n "${dsh_runtime}" ]; then
      echo "# ── 本机额外保护（--init 探测）──"
      echo "# DSH 运行时：~/.dsh/profiles/node_modules 下的符号链接指向它，删了 DSH 插件体系会坏"
      printf '%s\n' "${dsh_runtime}" | sed "s|${HOME}|~|"
      echo
    fi
    if [ -n "${live}" ]; then
      echo "# ── 你原有的白名单条目（并入基准）──"
      grep -vE '^\s*(#|$)' "${live}" | sed 's/[[:space:]]*$//'
      echo
    fi
  } > "${MC_STATE_DIR}/.whitelist.reference.tmp"

  # 去重（保留注释与空行，只对模式行去重；顺序保持"内置在前、额外在后"）
  awk '/^[[:space:]]*#/ {print; next}
       /^[[:space:]]*$/ {print; next}
       !seen[$0]++' "${MC_STATE_DIR}/.whitelist.reference.tmp" > "${MC_STATE_DIR}/.whitelist.reference.dedup" \
    && mv "${MC_STATE_DIR}/.whitelist.reference.dedup" "${MC_STATE_DIR}/.whitelist.reference.tmp"

  if [ -f "${MC_REF_WHITELIST}" ] && [ "${force}" -ne 1 ]; then
    echo "· 已存在，跳过：whitelist.reference（要重建加 --force）"
    skipped=$((skipped + 1))
    rm -f "${MC_STATE_DIR}/.whitelist.reference.tmp"
  else
    if [ -f "${MC_REF_WHITELIST}" ]; then
      local bak
      bak="$(_mc_backup_if_exists "${MC_REF_WHITELIST}")"
      [ -n "${bak}" ] && echo "  备份：${bak#"${MC_STATE_DIR}"/}"
    fi
    mv "${MC_STATE_DIR}/.whitelist.reference.tmp" "${MC_REF_WHITELIST}"
    echo "✓ 写入：whitelist.reference"
    wrote=$((wrote + 1))
  fi

  # expect-absent.list = 基准里当前命中不到路径的条目（自动算出来，避免噪音）
  # critical.list = 实际存在的关键资产
  # watch.list    = 通用观察清单
  if [ "${force}" -eq 1 ] || [ ! -f "${MC_EXPECT_ABSENT}" ] || [ ! -f "${MC_CRITICAL_LIST}" ] || [ ! -f "${MC_WATCH_LIST}" ]; then
    # 临时把参考清单读进来，算出不命中的
    local tmp_absent="${MC_STATE_DIR}/.expect.tmp"
    {
      echo "# 允许"命中不到路径"的白名单条目（--init 自动生成）"
      echo "# 这些条目在本机当前不存在（App 没装/已卸载/尚未创建），不算错误。"
      echo "# 你自己新加的白名单条目如果不在此列表里、又命中不到路径，guard 会 WARN 提醒可能是写错了。"
      echo
      if [ -f "${MC_REF_WHITELIST}" ]; then
        while IFS= read -r p; do
          case "${p}" in ""|\#*) continue ;; esac
          aux="${p/#\~/${HOME}}"
          _mc_pattern_hits "${aux}" || printf '%s\n' "${p}"
        done < "${MC_REF_WHITELIST}"
      fi
    } > "${tmp_absent}"

    if [ "${force}" -eq 1 ] || [ ! -f "${MC_EXPECT_ABSENT}" ]; then
      [ -f "${MC_EXPECT_ABSENT}" ] && _mc_backup_if_exists "${MC_EXPECT_ABSENT}" > /dev/null
      mv "${tmp_absent}" "${MC_EXPECT_ABSENT}"
      local n_absent
      n_absent="$(grep -vcE '^\s*(#|$)' "${MC_EXPECT_ABSENT}" 2>/dev/null || true)"
      echo "✓ 写入：expect-absent.list（${n_absent:-0} 条「本机暂无」）"
      wrote=$((wrote + 1))
    else
      rm -f "${tmp_absent}"
      echo "· 已存在，跳过：expect-absent.list（要重建加 --force）"
      skipped=$((skipped + 1))
    fi

    if [ "${force}" -eq 1 ] || [ ! -f "${MC_CRITICAL_LIST}" ]; then
      [ -f "${MC_CRITICAL_LIST}" ] && _mc_backup_if_exists "${MC_CRITICAL_LIST}" > /dev/null
      {
        echo "# 必须存在的关键资产：缺了 = BROKEN（--init 只写本机确实存在的）"
        echo "# 格式：<绝对路径>|<说明>"
        echo
        [ -n "${dsh_runtime}" ] && echo "${dsh_runtime}|DSH 运行时（~/.dsh/profiles/node_modules 的符号链接指向它）"
        [ -d "${HOME}/.dsh/profiles" ] && echo "${HOME}/.dsh/profiles|DSH profile 与 node_modules 符号链接"
        [ -d "${HOME}/.dsh" ] && echo "${HOME}/.dsh|DSH 配置根目录"
      } > "${MC_CRITICAL_LIST}"
      echo "✓ 写入：critical.list"
      wrote=$((wrote + 1))
    else
      echo "· 已存在，跳过：critical.list（要重建加 --force）"
      skipped=$((skipped + 1))
    fi

    if [ "${force}" -eq 1 ] || [ ! -f "${MC_WATCH_LIST}" ]; then
      [ -f "${MC_WATCH_LIST}" ] && _mc_backup_if_exists "${MC_WATCH_LIST}" > /dev/null
      {
        echo "# 只观察、不判失败的资产（本机没装就是没有，报出来只是噪音）"
        echo "# 格式：<绝对路径>|<说明>"
        echo
        echo "${HOME}/.ollama/models|本地模型（重下几十 GB）"
        echo "${HOME}/Library/Mobile Documents|iCloud Drive"
        echo "${HOME}/Library/Application Support/JetBrains|JetBrains IDE 配置"
        echo "${HOME}/.gradle/caches|Gradle 依赖缓存"
        echo "${HOME}/Library/Caches/ms-playwright|Playwright 浏览器"
      } > "${MC_WATCH_LIST}"
      echo "✓ 写入：watch.list"
      wrote=$((wrote + 1))
    else
      echo "· 已存在，跳过：watch.list（要重建加 --force）"
      skipped=$((skipped + 1))
    fi
  else
    echo "· 三个清单文件均已存在，全部跳过（要重建加 --force）"
    skipped=$((skipped + 3))
  fi

  echo
  echo "════ 完成：写入 ${wrote} 个，跳过 ${skipped} 个 ════"
  echo
  echo "下一步："
  echo "  1) ./mac-cleanup.sh --check    # 只体检+预演+出报告，不删东西"
  echo "  2) ./install.sh                # 安装季度定时任务"
  echo
  echo "⚠️ 生成的 5 个文件都是本机专属的，已在 .gitignore 里排除。"
  return 0
}
