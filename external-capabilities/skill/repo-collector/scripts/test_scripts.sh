#!/usr/bin/env bash
# Deterministic offline tests for the repo-collector scripts.
# No network, no Bitable writes: only the local pre-write gate is exercised.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/repo-collector-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT

pass=0
fail=0

expect() {
  # expect <wanted-exit> <label> <command...>
  local want=$1 label=$2
  shift 2
  local got=0
  "$@" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "  ok   $label (exit $got)"
    pass=$((pass + 1))
  else
    echo "  FAIL $label: wanted exit $want, got $got" >&2
    fail=$((fail + 1))
  fi
}

cat > "$fixture/good.json" <<'JSON'
{
  "Repository URL": "[vercel-labs/skills](https://github.com/vercel-labs/skills)",
  "前端网页": "[skills.sh](https://skills.sh)",
  "项目类型": ["CLI 工具"],
  "主题标签": ["Skill", "CLI", "Discovery"],
  "Project": "vercel-labs/skills",
  "核心亮点": "add/use/find/update 全套命令；支持 80+ Agent。",
  "Owner/组织": "Vercel Labs",
  "参考价值": "安装器无需自研，让商店成为可解析源即可。",
  "项目简介": "开放 Agent Skill 生态的通用命令行工具。",
  "Stars": 32980,
  "跟进状态": ["参考中"],
  "收录日期": "2026-10-03T00:00:00+08:00"
}
JSON

echo "validate_record.py — accepted shapes"
expect 0 "well-formed record passes" \
  python3 "$script_dir/validate_record.py" "$fixture/good.json"

echo "validate_record.py — rejected shapes"
for case in \
  'unknown-option|"项目类型": ["不存在的类型"]' \
  'missing-required|"项目简介": ""' \
  'url-mismatch|"Repository URL": "[wrong/repo](https://github.com/wrong/repo)"' \
  'negative-stars|"Stars": -5' \
  'bad-datetime|"收录日期": "昨天"' \
  'github-path-as-homepage|"前端网页": "[docs](https://github.com/modelcontextprotocol/registry/tree/main/docs)"' \
  'multi-on-single-select|"项目类型": ["CLI 工具", "注册中心"]'
do
  label=${case%%|*}
  mutation=${case#*|}
  python3 - "$fixture" "$mutation" <<'PY'
import json, sys
path, mutation = sys.argv[1], sys.argv[2]
record = json.load(open(f"{path}/good.json", encoding="utf-8"))
key, _, raw = mutation.partition(": ")
record[key] = json.loads(raw)
json.dump(record, open(f"{path}/bad.json", "w", encoding="utf-8"), ensure_ascii=False)
PY
  expect 1 "$label is rejected" \
    python3 "$script_dir/validate_record.py" "$fixture/bad.json"
done

python3 - "$fixture" <<'PY'
import json, sys
record = json.load(open(f"{sys.argv[1]}/good.json", encoding="utf-8"))
record["无关字段"] = "x"
json.dump(record, open(f"{sys.argv[1]}/bad.json", "w", encoding="utf-8"), ensure_ascii=False)
PY
expect 1 "unknown field is rejected" \
  python3 "$script_dir/validate_record.py" "$fixture/bad.json"

echo "repo_meta.py — input validation (offline)"
expect 2 "malformed slug is rejected before any request" \
  python3 "$script_dir/repo_meta.py" "not-a-repo"
expect 64 "missing argument is a usage error" \
  python3 "$script_dir/repo_meta.py"

echo
if ((fail > 0)); then
  echo "FAIL: $fail of $((pass + fail)) checks failed" >&2
  exit 1
fi
echo "PASS: repo-collector script tests ($pass checks)"
