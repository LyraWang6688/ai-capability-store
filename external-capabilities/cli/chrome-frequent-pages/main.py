#!/usr/bin/env python3
"""把 Chrome 的高频访问页面收录进飞书「常用网页」表，并可导出书签 HTML。

只读 Chrome History（复制到临时目录后再读，不锁 Chrome），归一化 URL 后
按域名 + 路径聚合访问次数，过滤噪声与隐私站点。

用法：
    python3 main.py --dry-run            # 只看结果，不写表
    python3 main.py --write              # 写/更新飞书表
    python3 main.py --html ~/Desktop/常用网页.html   # 导出可导入 Chrome 的书签 HTML
"""
import argparse
import html
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
CONFIG_PATH = os.environ.get("CHROME_PAGES_CONFIG") or os.path.join(HOME, ".config", "chrome-frequent-pages", "config.json")
DEFAULT_CONFIG = {
    "chrome_profile_dir": os.path.join(HOME, "Library", "Application Support", "Google", "Chrome", "Default"),
    "days": 90,
    "min_visits": 8,
    "limit": 60,
    "exclude_hosts": ["mail.google.com", "accounts.google.com", "localhost", "127.0.0.1"],
    "base_token": "",
    "table_id": "",
    "identity": "user",
    "ignored_urls_file": os.path.join(HOME, ".config", "chrome-frequent-pages", "ignored_urls.txt"),
    "rules": {
        # 只保留一条：娱乐影视整站丢弃；其余精细规则已按需求移除
        "drop_hosts": ["yfsp.tv", "iyf.tv", "yifan.tv", "tv.cctv.com"],
        "drop_url_contains": [],
        "root_only_hosts": [],
        "drop_titles": [],
        "keep_urls": [],
        "one_per_host": True,
    },
}

# chrome time: microseconds since 1601-01-01
CHROME_EPOCH_OFFSET = 11644473600


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    else:
        print(f"[提示] 没有配置文件，使用默认值；可用 CHROME_PAGES_CONFIG 或 {CONFIG_PATH} 覆盖", file=sys.stderr)
    for key in ("chrome_profile_dir",):
        if isinstance(cfg.get(key), str):
            cfg[key] = os.path.expanduser(cfg[key])
    return cfg


def copy_history(profile_dir):
    if not os.path.isdir(profile_dir):
        raise SystemExit(f"找不到 Chrome profile：{profile_dir}")
    tmp = tempfile.mkdtemp(prefix="chrome-history-")
    for name in ("History", "History-wal", "History-shm"):
        src = os.path.join(profile_dir, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(tmp, name))
    target = os.path.join(tmp, "History")
    if not os.path.exists(target):
        raise SystemExit("复制 History 失败")
    return tmp, target


def normalize(url):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path.rstrip("/")
    # 飞书文档/表格按 token 聚合：只认路径开头的 /base/<token> 之类，
    # 避免把 open.feishu.cn/document/.../docs/bitable-v1 这种开发文档误折叠。
    import re as _re
    match = _re.match(r"^/(base|wiki|docx|sheets|docs|mindnote|slides)/([A-Za-z0-9]+)", path)
    if match:
        return host, f"/{match.group(1)}/{match.group(2)}"
    return host, path or "/"


def is_noise(url, host, exclude_hosts):
    # 只看 https；http、file://、localhost 等本地页面一律不看
    if not url.startswith("https://"):
        return True
    if not host:
        return True
    if host in exclude_hosts:
        return True
    low = url.lower()
    for bad in ("chrome://", "file://", "chrome-extension://", "/search?q=", "login", "signin", "accounts."):
        if bad in low:
            return True
    return False


def load_ignored(cfg):
    path = cfg.get("ignored_urls_file") or ""
    if not path:
        return set()
    path = os.path.expanduser(path)
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip()}


def apply_rules(url, host, title, rules):
    """Return None to drop, or the url to keep (root_only may rewrite it)."""
    keep_urls = set(rules.get("keep_urls") or [])
    if url in keep_urls:
        return url
    low = url.lower()
    for needle in (rules.get("drop_url_contains") or []):
        if needle.lower() in low:
            return None
    for dropped in (rules.get("drop_hosts") or []):
        if host == dropped.lower() or host.endswith("." + dropped.lower()):
            return None
    clean_title = (title or "").strip()
    for dead in (rules.get("drop_titles") or []):
        if clean_title == dead:
            return None
    root_only = {h.lower() for h in (rules.get("root_only_hosts") or [])}
    if host in root_only:
        from urllib.parse import urlsplit
        path = urlsplit(url).path or "/"
        if path.rstrip("/") != "":
            return None
        return "https://" + host + "/"
    return url


def collect(cfg):
    ignored = load_ignored(cfg)
    rules = cfg.get("rules") or {}
    tmp, db = copy_history(cfg["chrome_profile_dir"])
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        cutoff_us = int((datetime.now().timestamp() - cfg["days"] * 86400 + CHROME_EPOCH_OFFSET) * 1_000_000)
        rows = conn.execute(
            "SELECT url, title, visit_count, last_visit_time FROM urls WHERE last_visit_time > ? AND url LIKE 'http%'",
            (cutoff_us,),
        ).fetchall()
        conn.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    aggregated = {}
    for url, title, visits, last_us in rows:
        host, path = normalize(url)
        if is_noise(url, host, set(cfg["exclude_hosts"])):
            continue
        kept = apply_rules(url, host, title, rules)
        if kept is None:
            continue
        key = host + path
        last_ts = last_us / 1_000_000 - CHROME_EPOCH_OFFSET
        entry = aggregated.get(key)
        if entry is None:
            aggregated[key] = {
                "key": key,
                "url": f"https://{host}{path}" if host else url,
                "title": (title or "").strip(),
                "host": host,
                "visits": visits,
                "last": last_ts,
            }
        else:
            entry["visits"] += visits
            if last_ts > entry["last"]:
                entry["last"] = last_ts
            if not entry["title"] and title:
                entry["title"] = title.strip()

    items = [e for e in aggregated.values() if e["visits"] >= cfg["min_visits"] and e["url"] not in ignored]
    items.sort(key=lambda e: (e["visits"], e["last"]), reverse=True)
    if rules.get("one_per_host"):
        seen_hosts = set()
        collapsed = []
        for item in items:
            if item["host"] in seen_hosts:
                continue
            seen_hosts.add(item["host"])
            collapsed.append(item)
        items = collapsed
    if cfg["limit"]:
        items = items[: cfg["limit"]]
    for item in items:
        item["last_iso"] = datetime.fromtimestamp(item["last"]).strftime("%Y-%m-%d %H:%M")
    return items


def lark(args):
    result = subprocess.run(["lark-cli"] + args + ["--as", "user", "--format", "json"], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise SystemExit("lark-cli 失败：" + (result.stderr or result.stdout).strip()[:400])
    payload = json.loads(result.stdout or "{}")
    if payload.get("ok") is False:
        err = payload.get("error") or {}
        raise SystemExit("lark-cli 返回失败：" + str(err.get("message") or err)[:400])
    return payload


def existing_domains(cfg):
    # 表结构是「一行一个域名」；读失败必须中止，避免重复插入。
    data = lark(["base", "+record-list", "--base-token", cfg["base_token"], "--table-id", cfg["table_id"], "--limit", "200"])
    meta = data.get("data") or {}
    cols = meta.get("fields") or []
    rows = meta.get("data") or []
    ids = meta.get("record_id_list") or []
    if "域名" not in cols:
        raise SystemExit("表里没有「域名」列；请检查表结构")
    idx = {name: i for i, name in enumerate(cols)}
    out = {}
    for rid, row in zip(ids, rows):
        host = str(row[idx["域名"]] or "").strip()
        if host:
            out[host] = rid
    return out


def aggregate_by_host(items):
    """把页面级结果压成域名级：访问次数求和，标题取访问最多的那页。"""
    grouped = {}
    for item in items:
        host = item["host"]
        rec = grouped.get(host)
        if rec is None:
            grouped[host] = {
                "域名": host,
                "访问次数": item["visits"],
                "标题": (item["title"] or host)[:80],
                "_top": item["visits"],
            }
        else:
            rec["访问次数"] += item["visits"]
            if item["visits"] > rec["_top"]:
                rec["_top"] = item["visits"]
                rec["标题"] = (item["title"] or host)[:80]
    rows = sorted(grouped.values(), key=lambda r: r["访问次数"], reverse=True)
    for row in rows:
        row.pop("_top", None)
    return rows


def write_table(cfg, items):
    if not cfg["base_token"] or not cfg["table_id"]:
        raise SystemExit("配置里缺 base_token / table_id")
    known = existing_domains(cfg)
    create, update = [], []
    for row in aggregate_by_host(items):
        record = {
            "域名": row["域名"],
            "标题": row["标题"],
            "访问次数": row["访问次数"],
            "状态": ["已收录"],
        }
        if row["域名"] in known:
            update.append((known[row["域名"]], record))
        else:
            create.append(record)

    if create:
        lark(["base", "+record-batch-create", "--base-token", cfg["base_token"], "--table-id", cfg["table_id"],
              "--json", json.dumps({"create_records": create}, ensure_ascii=False)])
    for record_id, record in update:
        lark(["base", "+record-upsert", "--base-token", cfg["base_token"], "--table-id", cfg["table_id"],
              "--record-id", record_id, "--json", json.dumps(record, ensure_ascii=False)])
    return len(create), len(update)


def bookmarks_from_table(cfg, path):
    """把飞书表里每个唯一「域名」写成一个书签 HTML（https://域名/）。"""
    data = lark(["base", "+record-list", "--base-token", cfg["base_token"], "--table-id", cfg["table_id"], "--limit", "200"])
    meta = data.get("data") or {}
    cols = meta.get("fields") or []
    rows = meta.get("data") or []
    if "域名" not in cols:
        raise SystemExit("表里没有「域名」列")
    idx = {name: i for i, name in enumerate(cols)}
    hosts = sorted({str(row[idx["域名"]]).strip() for row in rows if str(row[idx["域名"]]).strip()})
    lines = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        "<TITLE>Bookmarks</TITLE>",
        "<H1>Bookmarks</H1>",
        "<DL><p>",
        "    <DT><H3>常用网页（域名）</H3>",
        "    <DL><p>",
    ]
    for host in hosts:
        lines.append(f'        <DT><A HREF="https://{html.escape(host)}/">{html.escape(host)}</A>')
    lines += ["    </DL><p>", "</DL><p>"]
    with open(os.path.expanduser(path), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return hosts


def write_html(items, path):
    lines = [
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
        '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
        "<TITLE>Bookmarks</TITLE>",
        "<H1>Bookmarks</H1>",
        "<DL><p>",
        '    <DT><H3>常用网页（chrome-frequent-pages）</H3>',
        "    <DL><p>",
    ]
    for item in items:
        title = html.escape(item["title"] or item["host"])
        lines.append(f'        <DT><A HREF="{html.escape(item["url"])}">{title}</A>')
    lines += ["    </DL><p>", "</DL><p>"]
    with open(os.path.expanduser(path), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def print_table(items):
    print(f"{'访问':>6}  {'最近访问':<16}  标题 / URL")
    print("-" * 78)
    for item in items:
        print(f"{item['visits']:>6}  {item['last_iso']:<16}  {item['title'][:30]}")
        print(f"{'':>6}  {'':<16}  {item['url']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只打印结果")
    parser.add_argument("--write", action="store_true", help="写入飞书表")
    parser.add_argument("--html", metavar="PATH", help="导出可导入 Chrome 的书签 HTML（按页面链接）")
    parser.add_argument("--bookmarks-from-table", metavar="PATH", help="按飞书表的「域名」列导出书签 HTML")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--days", type=int)
    parser.add_argument("--min-visits", type=int)
    args = parser.parse_args()

    cfg = load_config()
    if args.bookmarks_from_table:
        hosts = bookmarks_from_table(cfg, args.bookmarks_from_table)
        print(f"已按域名导出书签：{os.path.expanduser(args.bookmarks_from_table)}（{len(hosts)} 个域名）")
        for host in hosts:
            print("  -", host)
        return 0
    for key in ("limit", "days", "min_visits"):
        if getattr(args, key) is not None:
            cfg[key] = getattr(args, key)

    items = collect(cfg)
    if not items:
        print("没有满足条件的页面（可调低 --min-visits 或调大 --days）")
        return 0
    print(f"共 {len(items)} 个高频页面（窗口 {cfg['days']} 天，最少 {cfg['min_visits']} 次访问）\n")
    print_table(items)
    if args.html:
        write_html(items, args.html)
        print(f"\n已导出书签 HTML：{os.path.expanduser(args.html)}")
    if args.write:
        created, updated = write_table(cfg, items)
        print(f"\n飞书写入完成：新增 {created} 条，更新 {updated} 条")
    if not args.write and not args.html:
        print("\n（dry-run：没有写表；加 --write 写飞书，--html <路径> 导出书签）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
