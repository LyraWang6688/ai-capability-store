#!/usr/bin/env bash
# scripts/inbox-deliver.sh 的离线测试。
#
# 不连飞书、不连服务器：用一个 stub `inbox-deliver` 记录收到的参数，
# 断言「契约字段齐全、失败也要投递、通道没开时只告警不静默」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DELIVER="$ROOT/scripts/inbox-deliver.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "  ok    $1"; }
no() { fail=$((fail + 1)); echo "  FAIL  $1" >&2; }

run() { bash "$DELIVER" "$@"; }

# ---- 1. 通道未配置：只告警，退出 0 ----
if out="$(env -u INBOX_DELIVER_URL PATH=/usr/bin:/bin bash "$DELIVER" \
      --task demo --result 成功 --summary "ok" 2>&1)"; then
  if printf '%s' "$out" | grep -q "投递通道未配置"; then ok "未配置通道时打 warning"; else no "未配置通道时应打 warning"; fi
else
  no "未配置通道不应让任务失败"
fi

# ---- 2. 同机命令通道：参数按契约传齐 ----
mkdir -p "$TMP/bin"
cat > "$TMP/bin/inbox-deliver" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_OUT"
SH
chmod +x "$TMP/bin/inbox-deliver"

STUB_OUT="$TMP/args" PATH="$TMP/bin:/usr/bin:/bin" \
  bash "$DELIVER" --task repo-baseline-audit --result 失败 \
    --summary "12 个仓库，3 项不合格" --detail "https://example.com/run/1" >/dev/null
if grep -qx "repo-baseline-audit" "$TMP/args" \
   && grep -qx "失败" "$TMP/args" \
   && grep -qx "12 个仓库，3 项不合格" "$TMP/args" \
   && grep -qx "https://example.com/run/1" "$TMP/args"; then
  ok "命令通道收到 task/result/summary/detail"
else
  no "命令通道参数不对：$(tr '\n' '|' < "$TMP/args")"
fi

# ---- 3. 摘要截断到 100 字 ----
LONG="$(python3 -c 'print("长" * 130)')"
STUB_OUT="$TMP/args2" PATH="$TMP/bin:/usr/bin:/bin" \
  bash "$DELIVER" --task demo --result 成功 --summary "$LONG" >/dev/null 2>&1
GOT="$(grep -E '^长+$' "$TMP/args2" | head -1)"
if [ "${#GOT}" -le 100 ]; then ok "超长摘要被截断到 ≤100 字（${#GOT}）"; else no "摘要没有截断（${#GOT}）"; fi

# ---- 4. summary-file 优先于固定文案 ----
printf '从文件来的一句话\n' > "$TMP/summary.txt"
STUB_OUT="$TMP/args3" PATH="$TMP/bin:/usr/bin:/bin" \
  bash "$DELIVER" --task demo --result 成功 --summary-file "$TMP/summary.txt" >/dev/null
if grep -qx "从文件来的一句话" "$TMP/args3"; then ok "summary-file 被使用"; else no "summary-file 没生效"; fi

# ---- 5. 非法 result 直接拒绝 ----
if env -u INBOX_DELIVER_URL PATH=/usr/bin:/bin bash "$DELIVER" \
     --task demo --result OK --summary x >/dev/null 2>&1; then
  no "非法 result 应被拒绝"
else
  ok "非法 result 被拒绝"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "FAIL: inbox-deliver ($pass passed, $fail failed)"
  exit 1
fi
echo "PASS: inbox-deliver ($pass checks)"
