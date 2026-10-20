#!/bin/bash
# 本机探测 —— 让脚本在别人的 Mac 上也能跑
#
# 这个文件回答一个问题：这台机器上的 mo / Mole 源码 / DSH 运行时到底在哪？
# 全部动态探测，不硬编码任何 --prefix、用户目录或 npx 哈希。

# 可移植的 realpath（macOS 自带 bash 3.2 / 老 readlink 没有 -f）
mc_realpath() {
  local p="$1" dir
  [ -n "$p" ] || return 1
  local guard=0
  while [ -L "$p" ]; do
    guard=$((guard + 1))
    [ "${guard}" -le 40 ] || return 1
    dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    p="$(readlink "$p")" || return 1
    case "$p" in
      /*) ;;
      *) p="${dir}/${p}" ;;
    esac
  done
  dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "${dir}" "$(basename "$p")"
}

# 探测 mo 可执行文件：配置 > PATH > 常见前缀
detect_mo_bin() {
  if [ -n "${MC_MO_BIN:-}" ] && [ -x "${MC_MO_BIN}" ]; then
    printf '%s\n' "${MC_MO_BIN}"
    return 0
  fi
  if command -v mo > /dev/null 2>&1; then
    command -v mo
    return 0
  fi
  local c
  for c in /opt/homebrew/bin/mo /usr/local/bin/mo "${HOME}/.local/bin/mo" /usr/bin/mo; do
    if [ -x "${c}" ]; then
      printf '%s\n' "${c}"
      return 0
    fi
  done
  return 1
}

# 从 mo 的真实路径反推 Mole 的 lib/core/base.sh
#   .../Cellar/mole/<ver>/libexec/bin/mo  →  .../libexec/lib/core/base.sh
detect_mole_base_sh() {
  local mo real libexec
  mo="$(detect_mo_bin)" || return 1
  real="$(mc_realpath "${mo}")" || return 1
  libexec="$(dirname "$(dirname "${real}")")"
  if [ -f "${libexec}/lib/core/base.sh" ]; then
    printf '%s\n' "${libexec}/lib/core/base.sh"
    return 0
  fi
  # 兜底：brew --prefix（launchd 下可能没 PATH，所以放最后）
  local prefix
  prefix="$(/opt/homebrew/bin/brew --prefix mole 2>/dev/null || /usr/local/bin/brew --prefix mole 2>/dev/null || true)"
  if [ -n "${prefix}" ] && [ -f "${prefix}/libexec/lib/core/base.sh" ]; then
    printf '%s\n' "${prefix}/libexec/lib/core/base.sh"
    return 0
  fi
  return 1
}

# 从已安装的 Mole 源码里提取内置白名单模式（DEFAULT_ + SAFETY_）
mole_builtin_patterns() {
  local base
  base="$(detect_mole_base_sh)" || return 0
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

mole_version() {
  # 注意：`mo --version` 的第一行是空行，不能直接 head -1
  local mo
  mo="$(detect_mo_bin)" || { echo "unknown"; return; }
  "${mo}" --version 2>&1 | sed -n 's/.*[Vv]ersion[[:space:]]*//p' | head -1
}

# 探测 DSH 运行时：~/.dsh/profiles/node_modules 下的符号链接指向
#   ~/.npm/_npx/<hash>/node_modules/...
# 这个 <hash> 每台机器/每次 npx 安装都可能不同，所以必须反查，不能写死。
detect_dsh_runtime() {
  local l t rest hash
  for l in "${HOME}"/.dsh/profiles/node_modules/*; do
    [ -L "${l}" ] || continue
    t="$(mc_realpath "${l}")" || continue
    case "${t}" in
      "${HOME}"/.npm/_npx/*)
        rest="${t#"${HOME}"/.npm/_npx/}"
        hash="${rest%%/*}"
        [ -n "${hash}" ] && { printf '%s\n' "${HOME}/.npm/_npx/${hash}"; return 0; }
        ;;
    esac
  done
  return 0
}

# 探测现有的 ~/.config/mole/whitelist —— 首次 --init 时把它并进基准
detect_live_whitelist() {
  local f="${HOME}/.config/mole/whitelist"
  [ -f "${f}" ] && printf '%s\n' "${f}"
}
