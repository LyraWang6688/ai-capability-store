#!/usr/bin/env python3
"""douyin-collect — 把抖音视频收录进飞书「灵感作品」表。

只做三件事：解析分享文案 / 查重 / 写一条记录。不改表结构、不删不改既有记录。

用法：
    python3 collect.py parse "<分享文案或链接>"
    python3 collect.py check "<链接|分享文案|视频ID>"
    python3 collect.py collect "<分享文案或链接>" [--note "为什么好"] [--dry-run]

退出码：
    0  成功（check: 未收录）
    2  lark-cli / 读表失败
    3  缺少作者与标题（需要用户转发分享文案）
    10 check: 已收录
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

TARGET = json.loads((Path(__file__).with_name("target.json")).read_text(encoding="utf-8"))

UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

URL_RE = re.compile(r"https?://[^\s，。、；：！？\"'“”‘’）)】]+")
ID_RE = re.compile(r"(?:/video/|modal_id=|/share/video/)(\d{10,25})")
AUTHOR_RE = re.compile(r"【([^】]{1,40}?)的作品】")
AT_AUTHOR_RE = re.compile(r"@([^\s#【】]{1,30})")
SHARE_TAIL_RE = re.compile(
    r"(复制此链接[，,].*?观看视频[！!]?|打开Dou音搜索[，,]?直接观看视频[！!]?|"
    r"复制打开抖音[，,].*?看看|%[0-9A-Fa-f]{2}.*)$"
)


def lark_bin() -> str:
    return os.environ.get("LARK_CLI") or shutil.which("lark-cli") or "lark-cli"


def run_lark(args: list[str]) -> dict:
    proc = subprocess.run(
        [lark_bin(), *args, "--as", TARGET["identity"], "--format", "json"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"lark-cli exit {proc.returncode}: {proc.stderr.strip()[:400]}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"lark-cli 输出不是 JSON: {proc.stdout[:200]}") from exc


def resolve_url(url: str) -> str:
    """短链还原为最终地址；失败时原样返回。"""
    if "v.douyin.com" not in url and "iesdouyin.com/share" not in url:
        return url
    try:
        proc = subprocess.run(
            ["curl", "-sIL", "--max-time", "12", "-A", UA, "-o", "/dev/null",
             "-w", "%{url_effective}", url],
            capture_output=True,
            text=True,
            timeout=20,
        )
        final = proc.stdout.strip()
        return final or url
    except (subprocess.SubprocessError, OSError):
        return url


def extract_video_id(text: str) -> str | None:
    m = ID_RE.search(text)
    return m.group(1) if m else None


def clean_title(raw: str) -> str:
    text = URL_RE.sub(" ", raw).strip()
    text = SHARE_TAIL_RE.sub(" ", text).strip(" \t\r\n，。、；：!?！？-—_")
    text = re.sub(r"\s+", " ", text)
    return text[: TARGET["limits"]["title_max_len"]].strip()


def parse_share(text: str, resolve: bool = True) -> dict:
    text = (text or "").strip()
    if not text:
        raise ValueError("输入为空")

    urls = URL_RE.findall(text)
    url = urls[0] if urls else ""
    if url and resolve:
        url = resolve_url(url)

    author = ""
    m = AUTHOR_RE.search(text)
    if m:
        author = m.group(1).strip()
    else:
        m = AT_AUTHOR_RE.search(text)
        if m:
            author = m.group(1).strip()

    title = ""
    if m and "的作品】" in text:
        tail = text.split("的作品】", 1)[1]
        first_url = URL_RE.search(tail)
        if first_url:
            tail = tail[: first_url.start()]
        title = clean_title(tail)
    elif not urls and text:
        title = clean_title(text)

    video_id = extract_video_id(url) or extract_video_id(text)
    if video_id:
        canonical = f"https://www.douyin.com/video/{video_id}"
    else:
        canonical = url

    return {
        "author": author,
        "title": title,
        "video_id": video_id,
        "url": canonical,
        "resolved_url": url,
        "has_meta": bool(author or title),
    }


def field_index(payload: dict) -> tuple[list[str], list[list]]:
    data = payload.get("data", {})
    return data.get("fields", []), data.get("data", [])


def iter_rows() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        payload = run_lark([
            "base", "+record-list",
            "--base-token", TARGET["base_token"],
            "--table-id", TARGET["table_id"],
            "--limit", "200",
            "--offset", str(offset),
        ])
        fields, matrix = field_index(payload)
        if not fields:
            break
        ids = payload.get("data", {}).get("record_id_list", [])
        for i, row in enumerate(matrix):
            item = dict(zip(fields, row))
            if i < len(ids):
                item["_record_id"] = ids[i]
            rows.append(item)
        total = payload.get("data", {}).get("total")
        offset += len(matrix)
        if not matrix or (total is not None and offset >= total) or len(matrix) < 200:
            break
    return rows


def dup_of(rows: list[dict], parsed: dict) -> dict | None:
    url_field = TARGET["fields"]["url"]
    target_id = parsed.get("video_id")
    target_url = (parsed.get("url") or "").split("?")[0].rstrip("/")
    for row in rows:
        value = row.get(url_field) or ""
        if not isinstance(value, str):
            value = json.dumps(value, ensure_ascii=False)
        if target_id and target_id in value:
            return row
        if target_url and target_url in value.split("?")[0].rstrip("/"):
            return row
    return None


def record_url(record_id: str) -> str:
    return (
        f"{TARGET['wiki_url']}?table={TARGET['table_id']}&record={record_id}"
    )


def create_record(parsed: dict, note: str, dry_run: bool) -> dict:
    fields = {
        TARGET["fields"]["author"]: parsed["author"],
        TARGET["fields"]["title"]: parsed["title"],
        TARGET["fields"]["url"]: parsed["url"],
    }
    if note:
        fields[TARGET["fields"]["note"]] = note[: TARGET["limits"]["note_max_len"]]
    payload = {"create_records": [fields]}
    args = [
        "base", "+record-batch-create",
        "--base-token", TARGET["base_token"],
        "--table-id", TARGET["table_id"],
        "--json", json.dumps(payload, ensure_ascii=False),
    ]
    if dry_run:
        args.append("--dry-run")
    result = run_lark(args)
    rid = find_key(result, "record_id")
    return {"fields": fields, "record_id": rid, "raw": result}


def find_key(obj, key: str):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key and isinstance(v, str):
                return v
        for v in obj.values():
            found = find_key(v, key)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = find_key(v, key)
            if found:
                return found
    return None


def cmd_parse(args) -> int:
    parsed = parse_share(args.text, resolve=not args.no_resolve)
    print(json.dumps(parsed, ensure_ascii=False, indent=2))
    return 0 if parsed["has_meta"] else 3


def cmd_check(args) -> int:
    parsed = parse_share(args.text)
    rows = iter_rows()
    dup = dup_of(rows, parsed)
    if dup:
        rid = dup.get("_record_id")
        print(json.dumps({
            "exists": True,
            "record": dup,
            "record_url": record_url(rid) if rid else None,
        }, ensure_ascii=False, indent=2))
        return 10
    print(json.dumps({"exists": False, "parsed": parsed}, ensure_ascii=False, indent=2))
    return 0


def cmd_collect(args) -> int:
    parsed = parse_share(args.text)
    if not parsed["has_meta"] and not args.allow_blank:
        print(json.dumps({
            "ok": False,
            "reason": "missing_meta",
            "message": "只拿到链接，没有作者和标题。请转发抖音的分享文案（自带【作者的作品】标题），或补 --allow-blank。",
            "parsed": parsed,
        }, ensure_ascii=False, indent=2))
        return 3

    dup = dup_of(iter_rows(), parsed)
    if dup:
        print(json.dumps({"ok": False, "reason": "duplicate", "record": dup},
                         ensure_ascii=False, indent=2))
        return 10

    created = create_record(parsed, args.note or "", args.dry_run)
    rid = created.get("record_id")
    out = {
        "ok": True,
        "dry_run": bool(args.dry_run),
        "record_id": rid,
        "record_url": record_url(rid) if rid else TARGET["wiki_url"],
        "fields": created["fields"],
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="收录抖音视频到飞书「灵感作品」")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("parse", help="只解析，不访问飞书")
    p.add_argument("text")
    p.add_argument("--no-resolve", action="store_true", help="不解析短链（离线）")
    p.set_defaults(func=cmd_parse)

    c = sub.add_parser("check", help="查重")
    c.add_argument("text")
    c.set_defaults(func=cmd_check)

    w = sub.add_parser("collect", help="查重后写入")
    w.add_argument("text")
    w.add_argument("--note", default="", help="创作灵感/为什么值得收")
    w.add_argument("--dry-run", action="store_true")
    w.add_argument("--allow-blank", action="store_true", help="允许只有链接")
    w.set_defaults(func=cmd_collect)

    args = ap.parse_args()
    try:
        return args.func(args)
    except RuntimeError as exc:
        print(json.dumps({"ok": False, "reason": "lark_error", "message": str(exc)},
                         ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
