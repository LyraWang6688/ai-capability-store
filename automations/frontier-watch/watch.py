#!/usr/bin/env python3
"""frontier-watch — 每周抓取豆包工作 / Codex / Claude 的新功能，写入飞书 Base。

只采集事实与插件可行性判断，不自动开发任何插件。
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import date
from hashlib import sha256
from pathlib import Path

HOME = Path.home()
STATE_DIR = Path(os.environ.get("FRONTIER_WATCH_HOME", HOME / ".automation-state" / "frontier-watch"))
STATE_FILE = STATE_DIR / "state.json"
CONFIG_FILE = STATE_DIR / "config.json"

DEFAULTS = {
    "base_token": "",
    "table_id": "",
    "lark_cli": "lark-cli",
    "lark_profile": "",
    "model": "deepseek-flash",
    "model_base_url": "https://api.deepseek.com",
    "api_key_env": "DEEPSEEK_API_KEY",
    "keychain_service": "DEEPSEEK_API_KEY",
    "sources": {
        "codex": "https://api.github.com/repos/openai/codex/releases?per_page=8",
        "claude": "https://support.claude.com/en/articles/12138966-release-notes",
    },
}

PROMPT = """你是 AI 产品功能观察员。下面是一份发布说明/更新日志，请提取「新增或变化的产品功能」，
忽略纯模型版本发布、价格与营销内容。输出严格 JSON 数组，每项：
{"feature":"功能名(中文,<=20字)","desc":"一句话说明(<=60字)","tool":"Codex|Claude|豆包工作","feasible":"可以|部分|不适合","difficulty":"小|中|大","priority":"高|中|低"}
只输出 JSON，不要解释。"""


def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        cfg.update(json.loads(CONFIG_FILE.read_text()))
    return cfg


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {"codex_tag": "", "claude_hash": "", "seen": []}


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "frontier-watch/0.1", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read().decode("utf-8", "replace")


def strip_html(html):
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def api_key(cfg):
    value = os.environ.get(cfg["api_key_env"], "").strip()
    if value:
        return value
    try:
        out = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", cfg["keychain_service"], "-w"],
            capture_output=True, text=True, timeout=15,
        )
        return out.stdout.strip()
    except Exception:
        return ""


def ask_model(cfg, text):
    key = api_key(cfg)
    if not key:
        raise SystemExit("缺少模型 API Key（环境变量或钥匙串）")
    payload = json.dumps({
        "model": cfg["model"],
        "temperature": 0.2,
        "stream": False,
        "messages": [
            {"role": "system", "content": "只输出 JSON。"},
            {"role": "user", "content": PROMPT + "\n\n材料：\n" + text[:20000]},
        ],
    }).encode()
    req = urllib.request.Request(
        cfg["model_base_url"].rstrip("/") + "/chat/completions",
        data=payload,
        headers={"content-type": "application/json", "authorization": "Bearer " + key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        data = json.loads(response.read().decode())
    content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    content = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.M).strip()
    match = re.search(r"\[.*\]", content, re.S)
    if not match:
        return []
    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    return [item for item in items if isinstance(item, dict) and item.get("feature")]


def lark(cfg, args, timeout=120):
    argv = [cfg["lark_cli"]]
    if cfg.get("lark_profile"):
        argv += ["--profile", cfg["lark_profile"]]
    argv += args + ["--as", "user", "--format", "json"]
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def existing_features(cfg):
    """Read every existing feature name (columnar JSON, 200 rows per page)."""
    names = set()
    offset = 0
    while True:
        result = lark(cfg, [
            "base", "+record-list",
            "--base-token", cfg["base_token"],
            "--table-id", cfg["table_id"],
            "--limit", "200",
            "--offset", str(offset),
        ])
        if result.returncode != 0:
            raise SystemExit("读取 Base 失败：" + (result.stderr or result.stdout)[:300])
        payload = json.loads(result.stdout)
        data = payload.get("data") or {}
        columns = data.get("fields") or []
        rows = data.get("data") or []
        index = columns.index("功能/灵感") if "功能/灵感" in columns else 0
        for row in rows:
            if index >= len(row):
                continue
            value = row[index]
            if isinstance(value, list) and value:
                value = value[0]
            if isinstance(value, dict):
                value = value.get("text") or value.get("name")
            if value:
                names.add(str(value).strip())
        if not data.get("has_more") or not rows:
            break
        offset += len(rows)
    return names


def append_records(cfg, items):
    today = date.today().isoformat()
    records = [{
        "功能/灵感": item["feature"],
        "工具": [item.get("tool") or "Codex"],
        "类型": ["新功能"],
        "说明": item.get("desc", ""),
        "可否做成DSH插件": [item.get("feasible") or "部分"],
        "难度": [item.get("difficulty") or "中"],
        "优先级": [item.get("priority") or "中"],
        "状态": ["候选"],
        "来源": "frontier-watch",
        "收录日": today,
    } for item in items]
    if not records:
        return 0
    payload = json.dumps({"create_records": records}, ensure_ascii=False)
    tmp = STATE_DIR / "batch.json"
    tmp.write_text(payload)
    result = lark(cfg, ["base", "+record-batch-create", "--base-token", cfg["base_token"], "--table-id", cfg["table_id"], "--json", "@" + str(tmp)])
    tmp.unlink(missing_ok=True)
    if result.returncode != 0:
        raise SystemExit("写入 Base 失败：" + (result.stderr or result.stdout)[:300])
    return len(records)


def seed(cfg):
    """Baseline: remember what exists now, write nothing (used once at install)."""
    state = load_state()
    try:
        releases = json.loads(fetch(cfg["sources"]["codex"]))
        if releases:
            state["codex_tag"] = releases[0].get("tag_name", "")
    except Exception as error:
        print("codex 抓取失败:", error, file=sys.stderr)
    try:
        state["claude_hash"] = sha256(strip_html(fetch(cfg["sources"]["claude"])).encode()).hexdigest()[:16]
    except Exception as error:
        print("claude 抓取失败:", error, file=sys.stderr)
    save_state(state)
    print(json.dumps({"seeded": True, "codex_tag": state.get("codex_tag")}, ensure_ascii=False))


def main():
    cfg = load_config()
    if "--seed" in sys.argv:
        seed(cfg)
        return
    if not cfg["base_token"] or not cfg["table_id"]:
        raise SystemExit("未配置 base_token/table_id：" + str(CONFIG_FILE))
    state = load_state()
    new_items = []

    # Codex: only the newest release not seen before
    try:
        releases = json.loads(fetch(cfg["sources"]["codex"]))
        if releases:
            newest = releases[0]
            if newest.get("tag_name") != state.get("codex_tag"):
                body = (newest.get("body") or "")[:12000]
                text = "版本 " + str(newest.get("tag_name")) + "\n" + body
                new_items += ask_model(cfg, text)
                state["codex_tag"] = newest.get("tag_name")
    except Exception as error:
        print("codex 抓取失败:", error, file=sys.stderr)

    # Claude: hash the release-notes page, re-extract only when it changed
    try:
        html = fetch(cfg["sources"]["claude"])
        text = strip_html(html)
        digest = sha256(text.encode()).hexdigest()[:16]
        if digest != state.get("claude_hash"):
            new_items += ask_model(cfg, text[-16000:])
            state["claude_hash"] = digest
    except Exception as error:
        print("claude 抓取失败:", error, file=sys.stderr)

    # dedupe: within batch and against Base
    seen = set(state.get("seen", []))
    seen |= existing_features(cfg)
    unique = []
    for item in new_items:
        name = item["feature"].strip()
        if name and name not in seen:
            seen.add(name)
            unique.append(item)

    written = append_records(cfg, unique)
    state["seen"] = sorted(seen)[-800:]
    save_state(state)
    print(json.dumps({"new": len(unique), "written": written, "codex_tag": state.get("codex_tag")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
