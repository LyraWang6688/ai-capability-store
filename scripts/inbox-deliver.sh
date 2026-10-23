#!/usr/bin/env bash
# 任务侧投递封装：把定时任务的结果写进 DSH 收件箱。
#
# 契约（字段、谁负责什么、验收）：orchestrations/scheduled-task/dsh/COLLABORATION.md
#   - 任务结束（成功 / 失败 / 超时）都调用一次
#   - 字段：taskName / result / summary(≤100 字) / executedAt / detailUrl
#   - 通道由 DSH 侧提供；本脚本不存任何飞书凭据
#
# 通道优先级：
#   1. 同机有 `inbox-deliver`（self-hosted runner / 服务器）→ 直接调它
#   2. 环境变量 INBOX_DELIVER_URL（+ INBOX_DELIVER_TOKEN）→ HTTP 投递
#   3. 都没有 → 打 warning 后退出 0
#      「通道还没开」不该让任务本身失败，但也不能假装投递成功（不许静默）。
#
# 用法：
#   scripts/inbox-deliver.sh --task ops-audit --result 成功 \
#     --summary "磁盘 78%，2 个证书 7 天内到期" --detail /var/lib/ops-audit/reports/x.html
#   scripts/inbox-deliver.sh --task repo-baseline-audit --result 失败 --summary "..." \
#     --summary-file inbox-summary.txt
#
# 退出码：0 投递成功或通道未配置（有 warning）；1 通道配置了但投递失败；2 参数错误。
set -euo pipefail

TASK_NAME=""
RESULT=""
SUMMARY=""
SUMMARY_FILE=""
DETAIL=""
EXECUTED_AT=""

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --task)         TASK_NAME="${2:?--task 需要值}"; shift 2 ;;
    --result)       RESULT="${2:?--result 需要值}"; shift 2 ;;
    --summary)      SUMMARY="${2:?--summary 需要值}"; shift 2 ;;
    --summary-file) SUMMARY_FILE="${2:?--summary-file 需要值}"; shift 2 ;;
    --detail)       DETAIL="${2:-}"; shift 2 ;;
    --executed-at)  EXECUTED_AT="${2:?--executed-at 需要值}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TASK_NAME" ] || { echo "--task 必填" >&2; exit 2; }
case "$RESULT" in
  成功|失败|超时) ;;
  *) echo "--result 只能是 成功 / 失败 / 超时（收到: ${RESULT:-空}）" >&2; exit 2 ;;
esac

# 任务可以把一句话结论写进文件，比固定文案更有用。
if [ -z "$SUMMARY" ] && [ -n "$SUMMARY_FILE" ] && [ -s "$SUMMARY_FILE" ]; then
  SUMMARY="$(head -c 400 "$SUMMARY_FILE" | tr '\n' ' ' | sed 's/  */ /g; s/^ *//; s/ *$//')"
fi
[ -n "$SUMMARY" ] || SUMMARY="${TASK_NAME} 执行完成（${RESULT}）"

# 契约要求 ≤100 字。超了先截断并提示，而不是让整条投递失败。
MAX=100
if [ "${#SUMMARY}" -gt "$MAX" ]; then
  SUMMARY="${SUMMARY:0:$MAX}"
  echo "WARN: 摘要超过 ${MAX} 字，已截断" >&2
  echo "::warning::摘要超过 ${MAX} 字，已截断"
fi

# executedAt 缺省用当前时刻（毫秒）。
if [ -z "$EXECUTED_AT" ]; then
  EXECUTED_AT="$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s%3N)"
fi

# ---- 通道 1：同机命令（self-hosted runner / 服务器）----
if command -v inbox-deliver >/dev/null 2>&1; then
  args=(--task "$TASK_NAME" --result "$RESULT" --summary "$SUMMARY" --executed-at "$EXECUTED_AT")
  [ -n "$DETAIL" ] && args+=(--detail "$DETAIL")
  if inbox-deliver "${args[@]}"; then
    echo "OK: 已通过 inbox-deliver 投递 task=${TASK_NAME} result=${RESULT}"
    exit 0
  fi
  echo "ERROR: inbox-deliver 调用失败 task=${TASK_NAME}" >&2
  exit 1
fi

# ---- 通道 2：HTTP（GitHub Actions 云 runner）----
if [ -n "${INBOX_DELIVER_URL:-}" ]; then
  payload="$(python3 - "$TASK_NAME" "$RESULT" "$SUMMARY" "$EXECUTED_AT" "$DETAIL" <<'PY'
import json, sys
task, result, summary, executed_at, detail = sys.argv[1:6]
body = {
    "taskName": task,
    "result": result,
    "summary": summary,
    "executedAt": int(executed_at),
}
if detail:
    body["detailUrl"] = detail
print(json.dumps(body, ensure_ascii=False))
PY
)"
  headers=(-H 'content-type: application/json')
  if [ -n "${INBOX_DELIVER_TOKEN:-}" ]; then
    headers+=(-H "authorization: Bearer ${INBOX_DELIVER_TOKEN}")
  fi
  if curl -fsS --max-time 15 -X POST "$INBOX_DELIVER_URL" "${headers[@]}" -d "$payload" >/dev/null; then
    echo "OK: 已通过 HTTP 投递 task=${TASK_NAME} result=${RESULT}"
    exit 0
  fi
  echo "ERROR: HTTP 投递失败 task=${TASK_NAME} url=${INBOX_DELIVER_URL}" >&2
  exit 1
fi

# ---- 通道 3：未配置 ----
echo "WARN: 投递通道未配置（见 issue #295），本次未投递 task=${TASK_NAME} result=${RESULT}" >&2
echo "::warning::投递通道未配置（见 #295），本次未投递：${TASK_NAME} ${RESULT}"
exit 0
