#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Accept a frontier-watch payload over SSH stdin, ask headless DSH to extract
features, then write results to the Feishu Base and the task inbox.

stdin JSON:
  {"kind":"frontier","sources":{"codex":"...","claude":"...","doubao":"..."},"versions":[...]}

stdout JSON:
  {"ok":true,"features":N,"report":"/path/to.html","inbox":"summary"}
"""
import json, os, re, subprocess, sys
from datetime import datetime, timezone, timedelta

DSH_HOME = "/srv/dsh-jobs"
ENV_FILE = "/srv/dsh-jobs/env/app.env"
WORK = "/srv/dsh-jobs/work/frontier"
def _resolve_lark():
    for cand in ("/usr/bin/lark-cli", "/usr/local/bin/lark-cli",
                 "/srv/dsh-jobs/.local/bin/lark-cli"):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "lark-cli"


LARK = _resolve_lark()
BASE = os.environ.get("FRONTIER_BASE_TOKEN", "ZNjDb9TrpalLuCsw0macCeVdnld")
TABLE = os.environ.get("FRONTIER_TABLE_ID", "tblWJxpkTVSwWQJ6")
INBOX_BASE = os.environ.get("DSH_INBOX_BASE_TOKEN", "NeujbbOfcaPEvMsPIxscaJImn9d")
INBOX_TABLE = os.environ.get("DSH_INBOX_TABLE_ID", "tbl9LghPBTjFLH4N")
TASKS_TABLE = os.environ.get("DSH_INBOX_TASK_TABLE_ID", "tbl4k7ggY1paqoUn")
TASK_NAME = "frontier-watch"
STATE = "/srv/dsh-jobs/state/frontier.delivered"

TZ = timezone(timedelta(hours=8))
PROMPT = """你是 AI 产品功能观察员。下面是本周抓到的发布说明/新闻原文（JSON）。
请提取「新增或变化的产品功能」，忽略纯模型版本发布、价格与营销内容。
输出严格 JSON（不要解释、不要 markdown 代码块）：
{"features":[{"feature":"功能名(<=20字)","desc":"一句话(<=60字)","tool":"Codex|Claude|豆包工作","priority":"高|中|低"}],
 "summary":"一句话本周概览(<=80字)"}
若没有值得记录的新功能，features 返回空数组。"""


def load_env():
    data = {}
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    data[k.strip()] = v.strip().strip("'\"")
    except OSError:
        pass
    return data


def run_dsh(prompt, timeout=600):
    env = dict(os.environ)
    env.update(load_env())
    env["HOME"] = DSH_HOME
    env["PATH"] = "/srv/dsh-jobs/node/bin:/srv/dsh-jobs/.local/bin:/usr/local/bin:/usr/bin:/bin"
    res = subprocess.run(["dsh", "headless", prompt], cwd=DSH_HOME, env=env,
                         capture_output=True, text=True, timeout=timeout)
    return res.stdout, res.stderr


def parse_json(text):
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def lark(args):
    res = subprocess.run([LARK] + args + ["--as", "bot", "--format", "json"],
                         capture_output=True, text=True, timeout=120)
    try:
        payload = json.loads(res.stdout or "{}")
    except Exception:
        payload = {}
    if payload.get("ok") is False:
        raise RuntimeError(json.dumps(payload.get("error", payload), ensure_ascii=False))
    if res.returncode != 0:
        raise RuntimeError("lark-cli exit %s: %s" % (res.returncode, (res.stderr or "")[:300]))
    return payload


def existing_feature_names():
    payload = lark(["base", "+record-list", "--base-token", BASE, "--table-id", TABLE, "--limit", "200"])
    meta = payload.get("data") or {}
    fields = meta.get("fields") or []
    rows = meta.get("data") or []
    if "功能/灵感" not in fields:
        return set()
    idx = fields.index("功能/灵感")
    return {str(row[idx]).strip() for row in rows if row[idx]}


def write_versions(items, today, seen):
    records = []
    for v in items or []:
        name = str(v.get("feature") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        records.append({
            "功能/灵感": name,
            "工具": [v.get("tool") if v.get("tool") in ("DSH", "DeepSeek API", "lark-cli", "Codex CLI") else "Codex"],
            "类型": ["版本更新"],
            "说明": str(v.get("desc") or "")[:200],
            "可否做成DSH插件": ["不适合"],
            "难度": ["小"],
            "优先级": [v.get("priority") if v.get("priority") in ("高", "中", "低") else "中"],
            "状态": ["候选"],
            "来源": str(v.get("source") or "frontier-watch")[:200],
            "收录日": today,
        })
    if records:
        lark(["base", "+record-batch-create", "--base-token", BASE, "--table-id", TABLE,
              "--json", json.dumps({"create_records": records}, ensure_ascii=False)])
    return len(records)


def write_features(items, today):
    if not items:
        return 0
    records = [{
        "功能/灵感": str(i.get("feature") or "")[:60],
        "工具": [i.get("tool") if i.get("tool") in ("Codex", "Claude", "豆包工作") else "Codex"],
        "类型": ["新功能"],
        "说明": str(i.get("desc") or "")[:200],
        "可否做成DSH插件": ["部分"],
        "难度": ["中"],
        "优先级": [i.get("priority") if i.get("priority") in ("高", "中", "低") else "中"],
        "状态": ["候选"],
        "来源": "frontier-watch",
        "收录日": today,
    } for i in items if i.get("feature")]
    if not records:
        return 0
    lark(["base", "+record-batch-create", "--base-token", BASE, "--table-id", TABLE,
          "--json", json.dumps({"create_records": records}, ensure_ascii=False)])
    return len(records)


def task_record_id(name):
    payload = lark(["base", "+record-list", "--base-token", INBOX_BASE, "--table-id", TASKS_TABLE, "--limit", "200"])
    meta = payload.get("data") or {}
    fields = meta.get("fields") or []
    rows = meta.get("data") or []
    ids = meta.get("record_id_list") or []
    if "任务名称" not in fields:
        return ""
    idx = fields.index("任务名称")
    for rid, row in zip(ids, rows):
        if str(row[idx]).strip() == name:
            return str(rid)
    return ""


def deliver(summary, result, detail):
    record = {
        "结果摘要": summary[:300],
        "结果": [result],
        "状态": ["未读"],
        "执行任务": int(datetime.now(TZ).timestamp() * 1000),
    }
    rid = task_record_id(TASK_NAME)
    if rid:
        record["关联任务"] = [rid]
    lark(["base", "+record-batch-create", "--base-token", INBOX_BASE, "--table-id", INBOX_TABLE,
          "--json", json.dumps({"create_records": [record]}, ensure_ascii=False)])


def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception:
        print(json.dumps({"ok": False, "error": "stdin is not JSON"}, ensure_ascii=False))
        return 2
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    os.makedirs(WORK, exist_ok=True)

    sources = payload.get("sources") or {}
    prompt = PROMPT + "\n\n" + json.dumps(sources, ensure_ascii=False)[:20000]
    out, err = run_dsh(prompt)
    data = parse_json(out)
    if data is None:
        summary = "frontier-watch：模型输出无法解析（前 80 字：" + out.strip()[:80] + "）"
        deliver(summary, "失败", "")
        print(json.dumps({"ok": False, "error": "unparsable model output", "stdout": out[:400],
                          "stderr": err[:400]}, ensure_ascii=False))
        return 3

    features = data.get("features") or []
    overview = str(data.get("summary") or "")
    written = 0
    versions_written = 0
    if payload.get("write", True):
        seen = existing_feature_names()
        versions_written = write_versions(payload.get("versions") or [], today, seen)
        written = write_features(features, today) if features else 0

    report_path = os.path.join(WORK, "frontier-%s.html" % today)
    html = ["<!doctype html><meta charset='utf-8'><title>前沿功能周报 %s</title>" % today,
            "<h1>前沿功能周报 %s</h1>" % today,
            "<p>%s</p>" % overview,
            "<ul>"]
    for i in features:
        html.append("<li><b>%s</b>（%s）：%s</li>" % (i.get("feature", ""), i.get("tool", ""), i.get("desc", "")))
    html.append("</ul>")
    versions = payload.get("versions") or []
    if versions:
        html.append("<h2>版本动态</h2><ul>")
        for v in versions:
            html.append("<li><b>%s</b>：%s</li>" % (v.get("feature", ""), v.get("desc", "")))
        html.append("</ul>")
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(html))

    summary = "frontier-watch：新功能 %d 条、版本动态 %d 条；%s" % (
        len(features), versions_written if payload.get("write", True) else len(payload.get("versions") or []), overview[:50])
    if payload.get("write", True):
        deliver(summary, "成功", report_path)
    print(json.dumps({"ok": True, "features": len(features), "versions_written": versions_written,
                      "written": written, "report": report_path, "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
