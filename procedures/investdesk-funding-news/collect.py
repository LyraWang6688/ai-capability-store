#!/usr/bin/env python3
"""投融资事件采集 —— Wind 财经新闻 → 飞书「投融资事件」表。

纪律（写死在代码里，不接受临场判断）：
  1. 金额只记录原文，不换算、不合并、不推断
  2. 只采集，不做投资建议
  3. 每条必须带来源链接 + 可信度分级
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
WIND_BASE = "https://mcp.wind.com.cn"       # 直连，不依赖本机安装的万得 skill
WIND_SERVER = "financial_docs"
DEFAULT_BASE = os.environ.get("INVESTDESK_BASE_TOKEN", "")   # 飞书 Base token，走环境变量
DEFAULT_TABLE = "tblrWsYmW93ujgqC"

# 关键词组：公司 → 检索意图
GROUPS = {
    # 国内
    "腾讯控股": "近一年腾讯控股的对外投资、并购、参股、出售资产新闻",
    "阿里巴巴": "近一年阿里巴巴集团的投资、并购、战略入股、减持新闻",
    "字节跳动": "近一年字节跳动（ByteDance）的融资、估值、投资并购新闻",
    "DeepSeek": "近一年 DeepSeek 深度求索 的融资、投资、股东新闻",
    # 海外
    "英伟达": "近一年英伟达（NVIDIA）的投资、并购、参股新闻",
    # 注意：问「谷歌 投资并购」会召回一堆财报与「如何买谷歌股票」的稿子；
    # 加上「收购、并购交易、投资入股」并显式带 Alphabet 才能命中交易类新闻。
    "谷歌": "近一年谷歌 Alphabet 收购、并购交易、投资入股新闻",
    "OpenAI": "近一年 OpenAI 的融资、估值、投资新闻",
    "苹果": "近一年苹果（Apple）的收购、投资、并购新闻",
}

# 事件类型：按顺序命中第一个
EVENT_RULES = [
    ("融资", r"融资|募资|筹得|募集|新一轮"),
    ("减持", r"减持|套现"),
    ("并购", r"收购|并购|出售|回购|私有化|股权转让|入股"),
    ("估值", r"估值"),
    ("投资", r"投资|参股|增资|投入|出资"),
]

CRED_RULES = [
    ("主流财经", r"路透|彭博|华尔街见闻|财新|证券时报|第一财经|财联社|中国经营报|21世纪经济报道|新华社|金十数据"),
    ("一般财经", r"证券之星|智通财经|雷达财经|智东西|野马财经|久期财经|界面新闻|每经|每日经济"),
]
# 两种写法都收：带币种（7亿美元）与不带币种（100亿）。原文照录，不补单位。
AMOUNT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(万亿|亿|千万)\s*(美元|人民币|港元|元)?"
                       r"|(\d+(?:\.\d+)?)\s*(美元|人民币|港元|元)")


# ---------------- 纯逻辑（可测） ----------------

def classify_event(title: str, body: str = "") -> str:
    """标题优先判定；标题看不出来时，只看正文开头 120 字（避免被后文带偏）。"""
    for name, pat in EVENT_RULES:
        if re.search(pat, title or ""):
            return name
    head = (body or "")[:120]
    for name, pat in EVENT_RULES:
        if re.search(pat, head):
            return name
    return "其他"


# 非事件类噪音：研报、评级、业绩点评、债券、人物文章
NOISE_RE = re.compile(r"评级|研报|目标价|维持|预计.*收入|债券|付息|点评|解读|复盘|"
                      r"价值投资|体系构建|启示|专访|访谈|书摘|"
                      r"如何|为什么|怎么看|解析|盘点|启示录|发生了什么")
QUESTION_RE = re.compile(r"[？?]$")
COMPANY_ALIAS = {
    "腾讯控股": r"腾讯", "阿里巴巴": r"阿里|阿里巴巴",
    "字节跳动": r"字节|ByteDance", "DeepSeek": r"DeepSeek|深度求索",
    "英伟达": r"英伟达|NVIDIA|Nvidia", "谷歌": r"谷歌|Alphabet|Google",
    "OpenAI": r"OpenAI|Open\s?AI", "苹果": r"苹果|Apple",
}


def classify_credibility(text: str) -> str:
    for name, pat in CRED_RULES:
        if re.search(pat, text):
            return name
    return "自媒体"


def extract_amounts(text: str, limit: int = 2) -> str:
    """只取原文里的金额写法，不换算。"""
    out = []
    for m in AMOUNT_RE.finditer(text):
        token = "".join(x for x in m.groups() if x)
        if token not in out:
            out.append(token)
        if len(out) >= limit:
            break
    return "；".join(out)


def summarize(text: str, limit: int = 140) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()[:limit]


def is_relevant(item: dict, company: str) -> bool:
    """只要"公司 + 真事件"的新闻；研报/评级/债券/人物稿一律丢弃。"""
    title = str(item.get("title") or "")
    body = str(item.get("content") or "")
    if NOISE_RE.search(title) or QUESTION_RE.search(title.strip()):
        return False
    alias = COMPANY_ALIAS.get(company, company)
    if not re.search(alias, title + " " + body[:80]):
        return False
    return classify_event(title, body) != "其他"


def dedupe(items: list[dict]) -> list[dict]:
    """同一 title 只留一条（取日期最新的）。"""
    best: dict[str, dict] = {}
    for it in items:
        key = re.sub(r"\s+", "", str(it.get("title") or ""))[:40]
        if not key:
            continue
        cur = best.get(key)
        if cur is None or str(it.get("date") or "") > str(cur.get("date") or ""):
            best[key] = it
    return list(best.values())


def to_record(item: dict, company: str, now_ms: int) -> dict:
    title = str(item.get("title") or "")
    body = str(item.get("content") or "")
    blob = title + " " + body
    ev = classify_event(title, body)
    cred = classify_credibility(body + " " + title)
    date = str(item.get("date") or "")
    return {
        "公司": company,
        "事件类型": ev,
        "新闻日期": int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=TZ).timestamp() * 1000) if date else None,
        "事件摘要": summarize(body),
        "金额原文": extract_amounts(title) or extract_amounts(body[:200]),
        "涉及方": "",
        "来源标题": title,
        "来源链接": str(item.get("url") or ""),
        "可信度": cred,
        "抓取时间": now_ms,
    }


# ---------------- IO ----------------

def _parse_payload(text: str) -> dict:
    text = text.strip()
    if text.startswith("{"):
        return json.loads(text)
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data and data != "[DONE]":
                return json.loads(data)
    raise RuntimeError(f"无法解析 Wind 响应: {text[:200]}")


class Wind:
    """最小 MCP 客户端：initialize + tools/call（响应可能是 SSE）。

    为什么不用 wind skill 的 cli.mjs：那条路依赖本机 ~/.agents 下的文件，
    GitHub Actions 的 runner 上没有，且别人要用也得先装一份 skill。
    """

    def __init__(self, api_key: str, server: str = WIND_SERVER, timeout: int = 60):
        self.key = api_key
        self.url = f"{WIND_BASE}/vserver_{server}/mcp/"
        self.timeout = timeout
        self.calls = 0

    def _rpc(self, method: str, params: dict) -> dict:
        body = json.dumps({"jsonrpc": "2.0", "id": int(datetime.now().timestamp() * 1000),
                           "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, data=body, method="POST", headers={
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            payload = _parse_payload(resp.read().decode())
        if payload.get("error"):
            err = payload["error"]
            raise RuntimeError(f"Wind {err.get('code')}: {err.get('message')}")
        return payload.get("result") or {}

    def news(self, query: str, top_k: int = 6) -> list[dict]:
        self._rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "investdesk-funding-news", "version": "0.2.0"}})
        self.calls += 1
        result = self._rpc("tools/call", {"name": "get_financial_news",
                                          "arguments": {"query": query, "top_k": top_k}})
        if result.get("isError"):
            raise RuntimeError(str((result.get("content") or [{}])[0].get("text"))[:300])
        inner = json.loads(result["content"][0]["text"])
        return (inner.get("data") or {}).get("items") or []


def base_existing_links(base: str, table: str, lark: str) -> set[str]:
    tmp = os.path.join(os.getcwd(), f".lark-tmp-{os.getpid()}.ndjson")
    try:
        subprocess.run([lark, "base", "+record-list", "--base-token", base,
                        "--table-id", table, "--limit", "2000", "--format", "ndjson",
                        "--output", tmp, "--as", "user"], capture_output=True, text=True, timeout=180)
        if not os.path.exists(tmp):
            return set()
        rows = [json.loads(x) for x in open(tmp, encoding="utf-8") if x.strip()]
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {str(r.get("来源链接") or "").strip() for r in rows if r.get("来源链接")}


def base_create(base: str, table: str, recs: list[dict], lark: str) -> int:
    if not recs:
        return 0
    path = os.path.join(os.getcwd(), f".lark-payload-{os.getpid()}.json")
    try:
        json.dump({"create_records": recs}, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        out = subprocess.run([lark, "base", "+record-batch-create", "--base-token", base,
                              "--table-id", table, "--json", f"@{path}", "--as", "user"],
                             capture_output=True, text=True, timeout=180)
        data = json.loads(out.stdout)
        if data.get("ok") is False:
            raise RuntimeError((data.get("error") or {}).get("message"))
        return len(recs)
    finally:
        os.unlink(path)


def build(s: "Wind", top_k: int) -> tuple[list[dict], dict]:
    """抓取 + 分类 → (待写入记录, 各公司统计)。不碰飞书。"""
    now_ms = int(time.time() * 1000)
    raw, report = [], {}
    for company, query in GROUPS.items():
        items = s.news(query, top_k)
        raw += [{**it, "_company": company} for it in items]
        report[company] = {"fetched": len(items)}
        time.sleep(0.3)
    recs, dropped = [], 0
    for it in dedupe(raw):
        if not is_relevant(it, it["_company"]):
            dropped += 1
            continue
        rec = to_record(it, it["_company"], now_ms)
        recs.append(rec)
        report[it["_company"]]["kept"] = report[it["_company"]].get("kept", 0) + 1
    return recs, {"by_company": report, "dropped_noise": dropped, "credits": s.calls}


def write(records: list[dict], base: str, table: str, lark: str) -> dict:
    """写入飞书（按来源链接去重）。只在有 Base 凭据的一侧执行。"""
    existing = base_existing_links(base, table, lark)
    recs, seen = [], set()
    for rec in records:
        link = str(rec.get("来源链接") or "").strip()
        if not link or link in existing or link in seen:
            continue
        seen.add(link)
        recs.append(rec)
    created = base_create(base, table, recs, lark)
    return {"payload": len(records), "to_create": len(recs), "created": created,
            "already_in_base": len(records) - len(recs)}


def main() -> None:
    ap = argparse.ArgumentParser(description="投融资事件采集（万得新闻 → 飞书）")
    ap.add_argument("--mode", choices=["fetch", "write", "all"], default="all",
                    help="fetch=只抓取产出 payload；write=只把 payload 写入飞书；all=两者都做")
    ap.add_argument("--in", dest="infile", default="", help="write 模式的 payload 文件（默认读 stdin）")
    ap.add_argument("--out", default="", help="fetch 模式的 payload 输出文件（默认 stdout）")
    ap.add_argument("--base-token", default=DEFAULT_BASE)
    ap.add_argument("--table", default=DEFAULT_TABLE)
    ap.add_argument("--top-k", type=int, default=6)
    ap.add_argument("--lark-cli", default="lark-cli")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.mode in ("fetch", "all"):
        key = os.environ.get("WIND_API_KEY", "").strip()
        if not key:
            raise SystemExit("缺少环境变量 WIND_API_KEY")
        recs, meta = build(Wind(key), args.top_k)
        payload = {"generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
                   "records": recs, "meta": meta}
        text = json.dumps(payload, ensure_ascii=False)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
            print(json.dumps({"out": args.out, "records": len(recs), **meta}, ensure_ascii=False))
        else:
            print(text)
        if args.mode == "fetch" or args.dry_run:
            return

    # write / all
    if not args.base_token:
        raise SystemExit("缺少 --base-token 或 INVESTDESK_BASE_TOKEN")
    if args.mode == "write":
        raw = open(args.infile, encoding="utf-8").read() if args.infile else sys.stdin.read()
        payload = json.loads(raw)
        recs = payload.get("records") or []
    else:
        recs = payload["records"]
    result = write(recs, args.base_token, args.table, args.lark_cli)
    print(json.dumps({"mode": args.mode, "records": len(recs), **result}, ensure_ascii=False))


if __name__ == "__main__":
    main()
