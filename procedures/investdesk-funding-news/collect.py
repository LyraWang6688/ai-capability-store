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


SENT_RE = re.compile(r"[^。！？!?\n]+[。！？!?]?")
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def summarize(text: str, limit: int = 200, min_len: int = 50) -> str:
    """按整句截断，不切断句子。

    原来的 `[:140]` 会把「…约等于一百亿人民币」切成半句，读起来像坏数据。
    现在贪心取整句直到 limit；若第一句就超长，才退化为硬截断并加省略号。
    """
    t = MD_LINK_RE.sub(r"\1", str(text or ""))
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return ""
    out = ""
    for m in SENT_RE.finditer(t):
        sent = m.group(0).strip()
        if not sent:
            continue
        if len(out) + len(sent) > limit:
            break
        out += sent
        if len(out) >= min_len:
            break
    if not out:
        return t[:limit].rstrip() + ("…" if len(t) > limit else "")
    return out


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


DATE_WINDOW_DAYS = 14
SIM_THRESHOLD = 0.35


def title_tokens(title: str) -> set[str]:
    t = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", str(title or ""))
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _day(ms: int | None) -> int:
    return int((ms or 0) // 86_400_000)


def same_event(a: dict, b: dict) -> bool:
    """同一事件的判据：同公司 + 同类型 + 日期相近 + （标题相似 或 金额写法相同）。"""
    if a.get("公司") != b.get("公司") or a.get("事件类型") != b.get("事件类型"):
        return False
    if abs(_day(a.get("新闻日期")) - _day(b.get("新闻日期"))) > DATE_WINDOW_DAYS:
        return False
    ta, tb = title_tokens(a.get("来源标题")), title_tokens(b.get("来源标题"))
    sim = len(ta & tb) / max(1, len(ta | tb))
    if sim >= SIM_THRESHOLD:
        return True
    amount = str(a.get("金额原文") or "").strip()
    return bool(amount) and amount == str(b.get("金额原文") or "").strip()


def cluster(records: list[dict]) -> list[list[dict]]:
    """把同一事件的多篇报道聚成一簇（先到先聚，O(n²)，量级在几百条以内够用）。"""
    groups: list[list[dict]] = []
    for rec in records:
        for g in groups:
            if same_event(g[0], rec):
                g.append(rec)
                break
        else:
            groups.append([rec])
    return groups


def merge_cluster(group: list[dict]) -> dict:
    """一簇 → 一条记录：日期取最早，摘要取最长，来源全部保留。"""
    group = sorted(group, key=lambda r: (r.get("新闻日期") or 0))
    best = max(group, key=lambda r: len(str(r.get("事件摘要") or "")))
    links = []
    for r in group:
        link = str(r.get("来源链接") or "").strip()
        if link and link not in links:
            links.append(link)
    merged = dict(best)
    merged["新闻日期"] = group[0].get("新闻日期")
    merged["来源链接"] = "\n".join(links)
    merged["来源数"] = len(links)
    others = [str(r.get("来源标题") or "") for r in group if r is not best]
    merged["其他来源"] = "\n".join(dict.fromkeys(others))[:1500]
    return merged


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


def base_rows(base: str, table: str, lark: str) -> list[dict]:
    tmp = os.path.join(os.getcwd(), f".lark-tmp-{os.getpid()}.ndjson")
    try:
        subprocess.run([lark, "base", "+record-list", "--base-token", base, "--table-id", table,
                        "--limit", "2000", "--format", "ndjson", "--output", tmp, "--as", "user"],
                       capture_output=True, text=True, timeout=180)
        if not os.path.exists(tmp):
            raise RuntimeError("读取投融资表失败（lark-cli 无输出）")
        return [json.loads(x) for x in open(tmp, encoding="utf-8") if x.strip()]
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _payload_json(path: str, obj: dict) -> str:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)
    return path


def _lark_batch(lark: str, base: str, table: str, action: str, body: dict) -> int:
    path = _payload_json(os.path.join(os.getcwd(), f".lark-payload-{os.getpid()}.json"), body)
    try:
        out = subprocess.run([lark, "base", action, "--base-token", base, "--table-id", table,
                              "--json", f"@{path}", "--as", "user"],
                             capture_output=True, text=True, timeout=180)
        data = json.loads(out.stdout)
        if data.get("ok") is False:
            raise RuntimeError((data.get("error") or {}).get("message"))
        ids = (data.get("data") or {}).get("record_id_list")
        return len(ids) if ids else 0
    finally:
        os.unlink(path)


def base_create(base: str, table: str, recs: list[dict], lark: str) -> int:
    if not recs:
        return 0
    return _lark_batch(lark, base, table, "+record-batch-create", {"create_records": recs})


def base_update(base: str, table: str, mapping: dict[str, dict], lark: str) -> int:
    if not mapping:
        return 0
    return _lark_batch(lark, base, table, "+record-batch-update", {"update_records": mapping})


def base_delete(base: str, table: str, record_ids: list[str], lark: str) -> int:
    if not record_ids:
        return 0
    args = [lark, "base", "+record-delete", "--base-token", base, "--table-id", table, "--yes", "--as", "user"]
    for rid in record_ids:
        args += ["--record-id", rid]
    out = subprocess.run(args, capture_output=True, text=True, timeout=180)
    data = json.loads(out.stdout)
    if data.get("ok") is False:
        raise RuntimeError((data.get("error") or {}).get("message"))
    return len(record_ids)


def _one(v):
    """飞书单选返回 ["值"]，统一取值。"""
    return v[0] if isinstance(v, list) and v else v


def normalize_existing(rows: list[dict]) -> list[dict]:
    """把飞书行转成与 payload 记录同构的字典，便于同一套 same_event 比较。"""
    out = []
    for r in rows:
        out.append({
            "record_id": r.get("record_id"),
            "公司": _one(r.get("公司")),
            "事件类型": _one(r.get("事件类型")),
            "来源标题": r.get("来源标题") or "",
            "新闻日期": _ms(r.get("新闻日期")),
            "金额原文": r.get("金额原文") or "",
            "事件摘要": r.get("事件摘要") or "",
            "来源链接": r.get("来源链接") or "",
            "来源数": r.get("来源数") or 1,
            "其他来源": r.get("其他来源") or "",
        })
    return out


def _ms(value) -> int:
    if isinstance(value, (int, float)):
        return int(value / 1000) * 1000 if value > 1e11 else int(value)
    if isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def build(wind: "Wind", top_k: int) -> tuple[list[dict], dict]:
    """抓取 + 分类 + 聚合成「事件」。不碰飞书。"""
    now_ms = int(time.time() * 1000)
    raw, report = [], {}
    for company, query in GROUPS.items():
        items = wind.news(query, top_k)
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
    merged = [merge_cluster(g) for g in cluster(recs)]
    return merged, {"by_company": report, "dropped_noise": dropped, "credits": wind.calls,
                    "articles": len(recs), "events": len(merged)}


def _merge_into(target: dict, extra: dict) -> dict:
    """把 extra 的来源并进 target（链接并集、来源数累加、摘要取更长的）。"""
    links = [x for x in str(target.get("来源链接") or "").split("\n") if x]
    for x in str(extra.get("来源链接") or "").split("\n"):
        if x and x not in links:
            links.append(x)
    others = [x for x in str(target.get("其他来源") or "").split("\n") if x]
    for x in str(extra.get("其他来源") or "").split("\n"):
        if x and x not in others:
            others.append(x)
    if str(extra.get("来源标题") or "") and extra.get("来源标题") != target.get("来源标题"):
        if extra["来源标题"] not in others:
            others.append(extra["来源标题"])
    out = dict(target)
    out["来源链接"] = "\n".join(links)
    out["来源数"] = len(links)
    out["其他来源"] = "\n".join(others)[:1500]
    if len(str(extra.get("事件摘要") or "")) > len(str(target.get("事件摘要") or "")):
        out["事件摘要"] = extra["事件摘要"]
    if extra.get("新闻日期") and (not out.get("新闻日期") or extra["新闻日期"] < out["新闻日期"]):
        out["新闻日期"] = extra["新闻日期"]
    return out


def write(records: list[dict], base: str, table: str, lark: str, dry_run: bool = False) -> dict:
    """写入飞书：同一事件已存在则合并来源，否则新建。"""
    existing = normalize_existing(base_rows(base, table, lark))
    updates: dict[str, dict] = {}
    creates: list[dict] = []
    for rec in records:
        hit = None
        for e in existing:
            if same_event(e, rec):
                hit = e
                break
        if hit is None:
            creates.append(rec)
            continue
        merged = _merge_into(hit, rec)
        updates[hit["record_id"]] = {k: merged[k] for k in
                                     ("来源链接", "来源数", "其他来源", "事件摘要", "新闻日期")}
    if dry_run:
        return {"records": len(records), "would_create": len(creates),
                "would_update": len(updates), "skipped": len(records) - len(creates) - len(updates)}
    return {"records": len(records),
            "created": base_create(base, table, creates, lark),
            "updated": base_update(base, table, updates, lark)}


def consolidate(base: str, table: str, lark: str, dry_run: bool = False) -> dict:
    """把表里已有的重复报道合并成一件事（保留最早一条，来源并进去，其余删除）。"""
    rows = normalize_existing(base_rows(base, table, lark))
    groups = cluster(rows)
    updates, deletes = {}, []
    for g in groups:
        if len(g) < 2:
            continue
        keeper = min(g, key=lambda r: r.get("新闻日期") or 0)
        merged = keeper
        for other in g:
            if other is not keeper:
                merged = _merge_into(merged, other)
        updates[keeper["record_id"]] = {k: merged[k] for k in
                                        ("来源链接", "来源数", "其他来源", "事件摘要", "新闻日期")}
        deletes += [r["record_id"] for r in g if r is not keeper]
    plan = {"rows": len(rows), "clusters": len(groups),
            "merge_clusters": len(updates), "update_rows": len(updates), "delete_rows": len(deletes)}
    if dry_run:
        return plan
    plan["updated"] = base_update(base, table, updates, lark)
    plan["deleted"] = base_delete(base, table, deletes, lark)
    return plan


def main() -> None:
    ap = argparse.ArgumentParser(description="投融资事件采集（万得新闻 → 飞书）")
    ap.add_argument("--mode", choices=["fetch", "write", "all", "consolidate"], default="all")
    ap.add_argument("--in", dest="infile", default="", help="write 模式的 payload 文件（默认 stdin）")
    ap.add_argument("--out", default="", help="fetch 模式的 payload 输出文件（默认 stdout）")
    ap.add_argument("--base-token", default=DEFAULT_BASE)
    ap.add_argument("--table", default=DEFAULT_TABLE)
    ap.add_argument("--top-k", type=int, default=6)
    ap.add_argument("--lark-cli", default="lark-cli")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.mode == "consolidate":
        if not args.base_token:
            raise SystemExit("缺少 --base-token 或 INVESTDESK_BASE_TOKEN")
        print(json.dumps(consolidate(args.base_token, args.table, args.lark_cli, args.dry_run),
                         ensure_ascii=False))
        return

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
            print(json.dumps({"out": args.out, "events": len(recs), **meta}, ensure_ascii=False))
        else:
            print(text)
        if args.mode == "fetch" or args.dry_run:
            return

    if not args.base_token:
        raise SystemExit("缺少 --base-token 或 INVESTDESK_BASE_TOKEN")
    if args.mode == "write":
        raw = open(args.infile, encoding="utf-8").read() if args.infile else sys.stdin.read()
        payload = json.loads(raw)
        recs = payload.get("records") or []
    else:
        recs = payload["records"]
    print(json.dumps({"mode": args.mode, **write(recs, args.base_token, args.table,
                                                 args.lark_cli, args.dry_run)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
