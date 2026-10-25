#!/usr/bin/env python3
"""持仓分析的「当日上下文」采集：大盘快照 + 持仓相关新闻。

直连万得 MCP over HTTP（不依赖本机安装的 wind skill），照 procedures/quote-sync
的既有做法：POST JSON-RPC，先 initialize 再 tools/call，响应可能是 SSE。

输出 JSON 给 investdesk-portfolio 这个 skill 读，skill 只负责分析，不负责取数。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
WIND_BASE = "https://mcp.wind.com.cn"
DEFAULT_INDICES = ("000001.SH", "399001.SZ", "399006.SZ", "000300.SH", "000688.SH", "HSI.HI")
INDEX_FIELDS = "中文简称,最新交易日,最新成交价,前收盘价,涨跌幅,涨跌,成交额"
NEWS_NOISE = re.compile(r"评级|研报|目标价|维持|预计.*收入|债券|付息|点评|解读|复盘|"
                        r"独家专访|访谈|书摘|如何|为什么|怎么看|"
                        r"深度|全面分析|分析报告|展望|观点|策略会")
NEWS_EVENT = re.compile(r"收购|并购|融资|减持|增持|投资|入股|股权|重组|分拆|上市|IPO|"
                        r"业绩|财报|中标|订单|停产|召回|处罚|调查|诉讼|回购|分红")


# ---------------- 万得 MCP over HTTP ----------------

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
    """最小 MCP 客户端：initialize + tools/call。"""

    def __init__(self, api_key: str, server: str = "index_data", timeout: int = 60):
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

    def tool(self, name: str, arguments: dict) -> dict:
        self._rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                 "clientInfo": {"name": "investdesk-daily-context", "version": "0.1.0"}})
        self.calls += 1
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(str((result.get("content") or [{}])[0].get("text"))[:300])
        inner = json.loads(result["content"][0]["text"])
        return inner.get("data") or {}


# ---------------- 纯逻辑（可测） ----------------

def fmt_amount(yuan: float | None) -> str:
    """元 → 亿/万，用于报表；不做四舍五入以外的加工。"""
    if not yuan:
        return "—"
    if abs(yuan) >= 1e8:
        return f"{yuan / 1e8:,.0f}亿"
    if abs(yuan) >= 1e4:
        return f"{yuan / 1e4:,.0f}万"
    return f"{yuan:,.0f}"


def parse_market(table: dict) -> list[dict]:
    cols = [c["name"] for c in (table.get("columns") or [])]
    idx = {n: i for i, n in enumerate(cols)}
    out = []
    for row in table.get("rows") or []:
        def get(name, default=None):
            i = idx.get(name)
            return row[i] if i is not None and i < len(row) else default
        try:
            last = float(get("最新成交价"))
            pct = float(get("涨跌幅"))
        except (TypeError, ValueError):
            continue
        out.append({
            "windcode": get("Wind代码"),
            "name": get("中文简称"),
            "date": get("最新交易日"),
            "last": last,
            "prev_close": float(get("前收盘价")) if get("前收盘价") else None,
            "pct": pct,
            "chg": float(get("涨跌")) if get("涨跌") else None,
            "turnover": float(get("成交额")) if get("成交额") else None,
        })
    return out


def pick_active(rows: list[dict], top_n: int) -> list[dict]:
    """按市值取前 N 只真正持有的标的（持有数量 > 0）。"""
    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    active = [r for r in rows if num(r.get("持有数量")) > 0]
    active.sort(key=lambda r: -num(r.get("最新市值")))
    return active[:top_n]


def news_query(name: str) -> str:
    return f"近一个月{name}的公告、业绩、并购、融资、股东变动相关新闻"


def is_useful_news(item: dict) -> bool:
    title = str(item.get("title") or "")
    body = str(item.get("content") or "")
    if NEWS_NOISE.search(title):
        return False
    return bool(NEWS_EVENT.search(title + " " + body[:120]))


# ---------------- 取数 ----------------

def lark_holdings(base: str, table: str, lark: str) -> list[dict]:
    tmp = os.path.join(os.getcwd(), f".lark-tmp-{os.getpid()}.ndjson")
    try:
        subprocess.run([lark, "base", "+record-list", "--base-token", base, "--table-id", table,
                        "--limit", "2000", "--format", "ndjson", "--output", tmp, "--as", "user"],
                       capture_output=True, text=True, timeout=180)
        if not os.path.exists(tmp):
            raise RuntimeError("读取持仓失败（lark-cli 无输出）")
        return [json.loads(x) for x in open(tmp, encoding="utf-8") if x.strip()]
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def market_snapshot(wind: Wind, indices: tuple[str, ...]) -> list[dict]:
    table = wind.tool("get_index_price_indicators",
                      {"windcode": ",".join(indices), "indexes": INDEX_FIELDS})
    return parse_market(table)


def holdings_news(wind: Wind, holdings: list[dict], per: int) -> list[dict]:
    out = []
    for h in holdings:
        name = str(h.get("名称") or "").strip()
        if not name:
            continue
        try:
            table = wind.tool("get_financial_news", {"query": news_query(name), "top_k": per})
        except RuntimeError as exc:
            out.append({"name": name, "code": h.get("代码"), "error": str(exc)[:120], "items": []})
            continue
        items = []
        for it in (table.get("items") or []):
            if not is_useful_news(it):
                continue
            items.append({"date": it.get("date"),
                          "title": str(it.get("title") or "")[:120],
                          "url": it.get("url"),
                          "summary": re.sub(r"\s+", " ", str(it.get("content") or ""))[:120]})
        out.append({"name": name, "code": h.get("代码"),
                    "mv": h.get("最新市值"), "items": items})
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="持仓分析的当日上下文：大盘 + 持仓新闻")
    ap.add_argument("--base-token", default=os.environ.get("INVESTDESK_BASE_TOKEN", ""))
    ap.add_argument("--holdings-table", default=os.environ.get("INVESTDESK_HOLDINGS_TABLE", ""))
    ap.add_argument("--top-n", type=int, default=15, help="按市值取前 N 只做新闻检索（默认 15）")
    ap.add_argument("--news-per", type=int, default=3, help="每只取几条新闻（默认 3）")
    ap.add_argument("--indices", default=",".join(DEFAULT_INDICES))
    ap.add_argument("--no-news", action="store_true", help="只取大盘，省积分")
    ap.add_argument("--out", default="", help="把结果写到文件，供 skill 读取")
    ap.add_argument("--lark-cli", default="lark-cli")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = os.environ.get("WIND_API_KEY", "").strip()
    if not key:
        sys.exit("缺少 WIND_API_KEY")
    if not args.no_news and (not args.base_token or not args.holdings_table):
        sys.exit("缺少 --base-token / --holdings-table（或 INVESTDESK_BASE_TOKEN / INVESTDESK_HOLDINGS_TABLE）")

    wind = Wind(key, server="index_data")
    market = market_snapshot(wind, tuple(x for x in args.indices.split(",") if x))

    holdings = []
    if not args.no_news:
        rows = lark_holdings(args.base_token, args.holdings_table, args.lark_cli)
        holdings = pick_active(rows, args.top_n)
        wind.url = f"{WIND_BASE}/vserver_financial_docs/mcp/"
        holdings = holdings_news(wind, holdings, args.news_per)

    ctx = {"generated_at": datetime.now(TZ).isoformat(timespec="seconds"),
           "trade_date": market[0]["date"] if market else None,
           "market": market,
           "holdings_news": holdings,
           "credits": wind.calls}
    text = json.dumps(ctx, ensure_ascii=False, indent=1)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    if args.dry_run or not args.out:
        print(text if args.dry_run else json.dumps(
            {"trade_date": ctx["trade_date"], "market": len(market),
             "holdings": len(holdings), "credits": wind.calls}, ensure_ascii=False))
    if args.out and not args.dry_run:
        print(json.dumps({"out": args.out, "trade_date": ctx["trade_date"],
                          "market": len(market), "holdings": len(holdings),
                          "credits": wind.calls}, ensure_ascii=False))


if __name__ == "__main__":
    main()
