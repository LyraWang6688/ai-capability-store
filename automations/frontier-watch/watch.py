#!/usr/bin/env python3
"""frontier-watch — 每周抓取 Codex / Claude 的新功能，写入飞书 Base。

执行在 GitHub Actions 上（见 .github/workflows/automation-frontier-watch.yml）：
走飞书「应用身份」tenant_access_token，不读本机 keychain，也不需要 lark-cli。
只采集事实与可行性判断，不开发插件、不改仓库、不删已有记录。
"""
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from hashlib import sha256

FEISHU_BASE = (os.environ.get("FEISHU_BASE") or "https://open.feishu.cn").rstrip("/")

DEFAULTS = {
    "base_token": "",
    "table_id": "",
    "model": "deepseek-flash",
    "model_base_url": "https://api.deepseek.com",
    "sources": {
        "codex": "https://api.github.com/repos/openai/codex/releases?per_page=8",
        "claude": "https://support.claude.com/en/articles/12138966-release-notes",
        # 豆包工作没有公开 changelog，也没有可抓的公众号；用公开报道兜底。
        # GitHub runner 在海外，可访问 Google News RSS；两个源互为备份，失败即跳过。
        "doubao": [
            "https://news.google.com/rss/search?q=%22%E8%B1%86%E5%8C%85%E5%B7%A5%E4%BD%9C%22&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
            "https://www.bing.com/news/search?q=%E8%B1%86%E5%8C%85%E5%B7%A5%E4%BD%9C&format=rss",
        ],
    },
    # 版本类监控（不经过模型，直接记录"最新版本 + 日期"）
    "version_sources": {
        "dsh_feed": "https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml",
        "dsh_releases": "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=1",
        "deepseek_api": "https://api-docs.deepseek.com/updates/",
        "lark_cli": "https://registry.npmjs.org/@larksuite/cli/latest",
        "codex_cli": "https://api.github.com/repos/openai/codex/releases?per_page=1",
    },
}

PROMPT = """你是 AI 产品功能观察员。下面是一份发布说明/更新日志，请提取「新增或变化的产品功能」，
忽略纯模型版本发布、价格与营销内容。输出严格 JSON 数组，每项：
{"feature":"功能名(中文,<=20字)","desc":"一句话说明(<=60字)","tool":"Codex|Claude|豆包工作","feasible":"可以|部分|不适合","difficulty":"小|中|大","priority":"高|中|低"}
只输出 JSON，不要解释。若某个功能与「已有条目」在语义上重复，跳过它。"""

_TOKEN = {"value": "", "expires_at": 0.0}


def load_config():
    raw = os.environ.get("FRONTIER_CONFIG_JSON")
    cfg = dict(DEFAULTS)
    if raw:
        cfg.update(json.loads(raw))
        return cfg
    path = os.path.expanduser("~/.automation-state/frontier-watch/config.json")
    if os.path.exists(path):
        cfg.update(json.loads(open(path, encoding="utf-8").read()))
    return cfg


def http_json(req, what):
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"{what} 请求失败：{exc}") from exc
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{what} 返回非 JSON：{raw[:300]}") from exc
    return payload


def tenant_token(refresh=False, app_id=None, app_secret=None):
    now = time.time()
    cache_key = (app_id or "") + "|" + (app_secret or "")
    cached = _TOKEN.get(cache_key)
    if cached and not refresh and now < float(cached.get("expires_at") or 0):
        return str(cached.get("value"))
    app_id = (app_id or os.environ.get("FEISHU_APP_ID") or "").strip()
    app_secret = (app_secret or os.environ.get("FEISHU_APP_SECRET") or "").strip()
    if not app_id or not app_secret:
        raise SystemExit("缺少飞书应用凭据：需要 FEISHU_APP_ID / FEISHU_APP_SECRET")
    req = urllib.request.Request(
        FEISHU_BASE + "/open-apis/auth/v3/tenant_access_token/internal",
        data=json.dumps({"app_id": app_id, "app_secret": app_secret}).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    payload = http_json(req, "tenant_access_token")
    if int(payload.get("code") or 0) != 0:
        raise SystemExit(f"tenant_access_token 被拒 [{payload.get('code')}] {payload.get('msg')}")
    token = str(payload.get("tenant_access_token") or "")
    if not token:
        raise SystemExit("tenant_access_token 响应缺字段")
    _TOKEN[cache_key] = {"value": token, "expires_at": now + max(60, int(payload.get("expire") or 7200) - 180)}
    return token


def feishu(method, path, params=None, body=None):
    url = FEISHU_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    for attempt in (0, 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + tenant_token(refresh=attempt == 1))
        if data is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        payload = http_json(req, f"{method} {path}")
        code = int(payload.get("code") or 0)
        if code == 0:
            return payload.get("data") or {}
        if attempt == 0 and code in (99991661, 99991663):
            continue
        raise SystemExit(f"飞书 API 报错 [{code}] {payload.get('msg')}（{method} {path}）")
    return {}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "frontier-watch/0.2", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=45) as response:
        return response.read().decode("utf-8", "replace")


def strip_html(markup):
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", markup)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return html.unescape(re.sub(r"\s+", " ", text)).strip()


def parse_rss(xml):
    """Extract (title, description, published) items from an RSS/Atom feed."""
    items = []
    for block in re.findall(r"(?is)<item\b.*?</item>", xml):
        title = re.search(r"(?is)<title>(.*?)</title>", block)
        desc = re.search(r"(?is)<description>(.*?)</description>", block)
        date = re.search(r"(?is)<pubDate>(.*?)</pubDate>", block)
        clean = lambda value: re.sub(r"(?s)<[^>]+>", " ", str(value or "").replace("<![CDATA[", "").replace("]]>", "")).strip()
        items.append({
            "title": clean(title.group(1) if title else ""),
            "description": clean(desc.group(1) if desc else ""),
            "date": clean(date.group(1) if date else ""),
        })
    return [item for item in items if item["title"]]


def doubao_news(cfg):
    """Public coverage of 豆包工作 (no official changelog / no scrapeable official account)."""
    entries = []
    for url in cfg["sources"].get("doubao", []):
        try:
            for item in parse_rss(fetch(url))[:15]:
                entries.append(item["title"] + " :: " + item["description"])
        except Exception as error:  # noqa: BLE001
            print("豆包工作新闻源失败:", url, error, file=sys.stderr)
    return "\n".join(entries)[:16000]


def ask_model(cfg, text, existing_names=()):
    key = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        raise SystemExit("缺少 DEEPSEEK_API_KEY")
    payload = json.dumps({
        "model": cfg["model"],
        "temperature": 0.2,
        "stream": False,
        "messages": [
            {"role": "system", "content": "只输出 JSON。"},
            {"role": "user", "content": PROMPT
                + ("\n\n已有条目（跳过语义重复）：\n" + "\n".join("- " + n for n in existing_names) if existing_names else "")
                + "\n\n材料：\n" + text[:20000]},
        ],
    }).encode()
    req = urllib.request.Request(
        cfg["model_base_url"].rstrip("/") + "/chat/completions",
        data=payload,
        headers={"content-type": "application/json", "authorization": "Bearer " + key},
        method="POST",
    )
    data = http_json(req, "model")
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


def records_path(cfg, *tail):
    return f"/open-apis/base/v3/bases/{cfg['base_token']}/tables/{cfg['table_id']}/records" + ("/" + "/".join(tail) if tail else "")


def existing_names(cfg):
    names = set()
    offset = 0
    while True:
        data = feishu("GET", records_path(cfg), params=[("limit", "200"), ("offset", str(offset))])
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


def append_records(cfg, items, dry_run):
    today = date.today().isoformat()
    records = [{
        "功能/灵感": item["feature"],
        "工具": [item.get("tool") or "Codex"],
        "类型": [item.get("type") or "新功能"],
        "说明": item.get("desc", ""),
        "可否做成DSH插件": [item.get("feasible") or ("不适合" if item.get("type") == "版本更新" else "部分")],
        "难度": [item.get("difficulty") or ("小" if item.get("type") == "版本更新" else "中")],
        "优先级": [item.get("priority") or "中"],
        "状态": ["候选"],
        "来源": (item.get("source") or "frontier-watch")[:200],
        "收录日": today,
    } for item in items]
    if not records:
        return 0
    if dry_run:
        print(json.dumps({"dry_run": True, "would_write": records}, ensure_ascii=False, indent=2))
        return 0
    written = 0
    for start in range(0, len(records), 200):
        chunk = records[start:start + 200]
        data = feishu("POST", records_path(cfg, "batch_create"), body={"create_records": chunk})
        written += len(data.get("record_id_list") or [])
    return written


def format_notification(items, base_url):
    """Build the Feishu text message for a batch of new entries (None when empty)."""
    if not items:
        return None
    lines = [f"【前沿功能监控】新增 {len(items)} 条"]
    for item in items[:8]:
        lines.append(f"· {item.get('feature', '')}（{item.get('tool', '')}，优先级 {item.get('priority', '')}）")
    if len(items) > 8:
        lines.append(f"…还有 {len(items) - 8} 条")
    if base_url:
        lines.append(base_url)
    return "\n".join(lines)


def _first_line(text, limit=80):
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line[:limit]
    return ""


def version_items(cfg):
    """版本类监控：DSH 桌面版 / DSH 上游 / DeepSeek API 变更日志 / lark-cli / Codex CLI。

    不求模型，直接产出「<工具> <版本或日期>」条目，说明里带来源与时间。
    """
    src = cfg.get("version_sources") or {}
    items = []

    # DSH 桌面版 feed（YAML 里的 version/releaseDate）
    if src.get("dsh_feed"):
        try:
            text = fetch(src["dsh_feed"])
            version = ""
            release = ""
            for line in text.splitlines():
                if line.startswith("version:"):
                    version = line.split(":", 1)[1].strip()
                elif line.startswith("releaseDate:"):
                    release = line.split(":", 1)[1].strip().strip("'\"").split("T")[0]
            if version:
                items.append({
                    "feature": "DSH 桌面版 " + version,
                    "desc": ("最新桌面版 " + version + ("（" + release + "）" if release else ""))[:60],
                    "tool": "DSH", "type": "版本更新", "priority": "高",
                    "source": src["dsh_feed"],
                })
        except Exception as error:  # noqa: BLE001
            print("dsh feed 抓取失败:", error, file=sys.stderr)

    # DSH 上游 release
    if src.get("dsh_releases"):
        try:
            releases = json.loads(fetch(src["dsh_releases"]))
            if releases:
                item = releases[0]
                tag = str(item.get("tag_name") or "")
                published = str(item.get("published_at") or "")[:10]
                if tag:
                    items.append({
                        "feature": "DSH 上游 " + tag,
                        "desc": ("仓库最新 release " + tag + ("（" + published + "）" if published else ""))[:60],
                        "tool": "DSH", "type": "版本更新", "priority": "中",
                        "source": src["dsh_releases"],
                    })
        except Exception as error:  # noqa: BLE001
            print("dsh releases 抓取失败:", error, file=sys.stderr)

    # DeepSeek API 变更日志（取最新一条 Date: 与标题）
    if src.get("deepseek_api"):
        try:
            text = strip_html(fetch(src["deepseek_api"]))[:8000]
            import re as _re
            m = _re.search(r"Date:\s*(\d{4}-\d{2}-\d{2})", text)
            if m:
                tail = html.unescape(_re.sub(r"\s+", " ", text[m.end():m.end() + 200])).strip()
                items.append({
                    "feature": "DeepSeek API " + m.group(1),
                    "desc": ("变更日志最新：" + tail[:48]),
                    "tool": "DeepSeek API", "type": "版本更新", "priority": "高",
                    "source": src["deepseek_api"],
                })
        except Exception as error:  # noqa: BLE001
            print("deepseek api 抓取失败:", error, file=sys.stderr)

    # lark-cli（@larksuite/cli）最新版本
    if src.get("lark_cli"):
        try:
            latest = json.loads(fetch(src["lark_cli"]))
            version = str(latest.get("version") or "")
            if version:
                items.append({
                    "feature": "lark-cli " + version,
                    "desc": ("npm 最新版本 " + version)[:60],
                    "tool": "lark-cli", "type": "版本更新", "priority": "中",
                    "source": src["lark_cli"],
                })
        except Exception as error:  # noqa: BLE001
            print("lark-cli 抓取失败:", error, file=sys.stderr)

    # Codex CLI（openai/codex releases）
    if src.get("codex_cli"):
        try:
            releases = json.loads(fetch(src["codex_cli"]))
            if releases:
                item = releases[0]
                tag = str(item.get("tag_name") or "")
                published = str(item.get("published_at") or "")[:10]
                if tag:
                    items.append({
                        "feature": "Codex CLI " + tag,
                        "desc": ("最新 release " + tag + ("（" + published + "）" if published else ""))[:60],
                        "tool": "Codex CLI", "type": "版本更新", "priority": "中",
                        "source": src["codex_cli"],
                    })
        except Exception as error:  # noqa: BLE001
            print("codex cli 抓取失败:", error, file=sys.stderr)

    return items


def collect_sources(cfg):
    """只抓原文，不调模型、不写表：给服务器无头 DSH 用。"""
    sources = {}
    try:
        releases = json.loads(fetch(cfg["sources"]["codex"]))
        if releases:
            newest = releases[0]
            sources["codex"] = "版本 " + str(newest.get("tag_name")) + "\n" + (newest.get("body") or "")[:12000]
    except Exception as error:  # noqa: BLE001
        print("codex 抓取失败:", error, file=sys.stderr)
    try:
        sources["claude"] = strip_html(fetch(cfg["sources"]["claude"]))[:12000]
    except Exception as error:  # noqa: BLE001
        print("claude 抓取失败:", error, file=sys.stderr)
    try:
        news = doubao_news(cfg)
        if news:
            sources["doubao"] = news[:8000]
    except Exception as error:  # noqa: BLE001
        print("豆包工作抓取失败:", error, file=sys.stderr)
    return sources


def main():
    if "--emit-all" in sys.argv:
        cfg = load_config()
        payload = {"sources": collect_sources(cfg), "versions": version_items(cfg)}
        print(json.dumps(payload, ensure_ascii=False))
        return

    dry_run = "--dry-run" in sys.argv
    cfg = load_config()
    if not cfg.get("base_token") or not cfg.get("table_id"):
        raise SystemExit("缺少 base_token / table_id（环境变量 FRONTIER_CONFIG_JSON 或本机配置）")

    seen = existing_names(cfg)
    print(f"Base 现有 {len(seen)} 条记录")
    candidates = []
    try:
        releases = json.loads(fetch(cfg["sources"]["codex"]))
        if releases:
            newest = releases[0]
            text = "版本 " + str(newest.get("tag_name")) + "\n" + (newest.get("body") or "")[:12000]
            candidates += ask_model(cfg, text, seen)[:15]
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print("codex 抓取失败:", error, file=sys.stderr)

    try:
        # 发布说明页是倒序累积的：只取头部（最新几个月），不把历史条目重新抽一遍
        text = strip_html(fetch(cfg["sources"]["claude"]))[:12000]
        candidates += ask_model(cfg, text, seen)[:15]
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print("claude 抓取失败:", error, file=sys.stderr)

    try:
        news = doubao_news(cfg)
        if news:
            for item in ask_model(cfg, news, seen)[:15]:
                item["tool"] = "豆包工作"
                candidates.append(item)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print("豆包工作提取失败:", error, file=sys.stderr)

    try:
        candidates += version_items(cfg)
    except Exception as error:  # noqa: BLE001
        print("版本监控失败:", error, file=sys.stderr)

    unique = []
    for item in candidates:
        name = str(item.get("feature") or "").strip()
        if name and name not in seen:
            seen.add(name)
            unique.append(item)

    written = append_records(cfg, unique, dry_run)
    print(json.dumps({"candidates": len(candidates), "new": len(unique), "written": written, "dry_run": dry_run}, ensure_ascii=False))


if __name__ == "__main__":
    main()
