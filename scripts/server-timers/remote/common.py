#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for the server-side automation runners.

Deployed to /srv/dsh-jobs/scripts/ and imported by the *-remote.py scripts.
These scripts accept a JSON payload over SSH stdin (forced command), decide
whether anything changed, call `dsh headless` when judgement is needed, publish
the HTML report under https://automation.bamamei.online/reports/..., and write
one row into the task inbox.

Design rules (see automations/README.md):
  * the change judgement is deterministic and runs BEFORE any model call;
  * only the changed branch calls `dsh headless` (that is where DeepSeek is used);
  * HTML goes to /srv/automation/www/reports/<automation>/<date>.html
    and the inbox row carries that public URL.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

DSH_HOME = os.environ.get("DSH_HOME", "/srv/dsh-jobs")
ENV_FILE = os.path.join(DSH_HOME, "env", "app.env")
STATE_DIR = os.path.join(DSH_HOME, "state")
HTML_ROOT = os.environ.get("AUTOMATION_HTML_ROOT", "/srv/automation/www")
HTML_BASE = os.environ.get("AUTOMATION_HTML_BASE", "https://automation.bamamei.online").rstrip("/")

INBOX_BASE = os.environ.get("DSH_INBOX_BASE_TOKEN", "NeujbbOfcaPEvMsPIxscaJImn9d")
INBOX_TABLE = os.environ.get("DSH_INBOX_TABLE_ID", "tbl9LghPBTjFLH4N")
TASKS_TABLE = os.environ.get("DSH_INBOX_TASK_TABLE_ID", "tbl4k7ggY1paqoUn")

TZ = timezone(timedelta(hours=8))


def _resolve_lark():
    for cand in ("/usr/bin/lark-cli", "/usr/local/bin/lark-cli",
                 os.path.join(DSH_HOME, ".local", "bin", "lark-cli")):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "lark-cli"


LARK = _resolve_lark()


def load_env():
    data = {}
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    data[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return data


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


def deliver(task, summary, result, detail_url=""):
    record = {
        "结果摘要": summary[:100],
        "结果": [result],
        "状态": ["未读"],
        "执行任务": int(datetime.now(TZ).timestamp() * 1000),
    }
    if detail_url:
        # 收件箱表当前只有文本字段；URL 拼进摘要，面板上可直接点开。
        record["结果摘要"] = (summary[:100] + "\n" + detail_url)[:300]
    rid = task_record_id(task)
    if rid:
        record["关联任务"] = [rid]
    lark(["base", "+record-batch-create", "--base-token", INBOX_BASE, "--table-id", INBOX_TABLE,
          "--json", json.dumps({"create_records": [record]}, ensure_ascii=False)])


def run_dsh(prompt, timeout=900):
    env = dict(os.environ)
    env.update(load_env())
    env["HOME"] = DSH_HOME
    env["PATH"] = ":".join([os.path.join(DSH_HOME, "node", "bin"),
                           os.path.join(DSH_HOME, ".local", "bin"),
                           "/usr/local/bin", "/usr/bin", "/bin"])
    res = subprocess.run(["dsh", "headless", prompt], cwd=DSH_HOME, env=env,
                         capture_output=True, text=True, timeout=timeout)
    return res.stdout, res.stderr


def parse_json(text):
    text = (text or "").strip()
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def fingerprint(obj):
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def state_path(task):
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, task + ".json")


def load_state(task):
    try:
        with open(state_path(task), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(task, data):
    with open(state_path(task), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def report_dir(task):
    path = os.path.join(HTML_ROOT, "reports", task)
    os.makedirs(path, exist_ok=True)
    return path


def publish_html(task, date, html, also_latest=True):
    """Write <date>.html (and latest.html) under the public reports directory."""
    path = os.path.join(report_dir(task), date + ".html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(html)
    os.chmod(path, 0o644)
    if also_latest:
        latest = os.path.join(report_dir(task), "latest.html")
        with open(latest, "w", encoding="utf-8") as fh:
            fh.write(html)
        os.chmod(latest, 0o644)
    return path


def report_url(task, date):
    return "%s/reports/%s/%s.html?v=%d" % (
        HTML_BASE, task, date, int(datetime.now(TZ).timestamp()))


def render_page(title, generated_at, summary, sections):
    """Small self-contained HTML page (inline CSS, no external assets)."""
    parts = [
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'>",
        "<meta name='robots' content='noindex,nofollow'>",
        "<title>%s</title>" % title,
        "<style>:root{color-scheme:light}body{font:16px/1.7 -apple-system,'PingFang SC',sans-serif;"
        "max-width:860px;margin:0 auto;padding:40px 20px;color:#1f2329;background:#fff}"
        "h1{font-size:24px;margin:0 0 6px}h2{font-size:19px;margin:32px 0 10px;padding-top:8px;"
        "border-top:1px solid #eef0f3}p,li{color:#333}h1+p{color:#8f959e;font-size:13px}"
        ".lead{background:#f5f7fa;border-radius:8px;padding:14px 18px;margin:18px 0}"
        "footer{margin-top:48px;color:#8f959e;font-size:12px}</style></head><body>",
        "<h1>%s</h1><p>%s · 数据来源：服务器 DSH</p>" % (title, generated_at),
    ]
    if summary:
        parts.append("<div class='lead'>%s</div>" % summary)
    for section in sections or []:
        heading = str(section.get("heading") or "").strip()
        if heading:
            parts.append("<h2>%s</h2>" % heading)
        for para in section.get("paragraphs") or []:
            parts.append("<p>%s</p>" % para)
        items = section.get("bullets") or []
        if items:
            parts.append("<ul>" + "".join("<li>%s</li>" % item for item in items) + "</ul>")
    parts.append("<footer>automation.bamamei.online · 自动生成</footer></body></html>")
    return "\n".join(parts)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")


def fail(message, code=3):
    emit({"ok": False, "error": message})
    return code


def read_payload(expect_kind):
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception:
        raise SystemExit("stdin is not JSON")
    kind = payload.get("kind")
    if expect_kind and kind and kind != expect_kind:
        raise SystemExit("unexpected kind %r" % kind)
    return payload


def mode_forced():
    return "--force" in sys.argv
