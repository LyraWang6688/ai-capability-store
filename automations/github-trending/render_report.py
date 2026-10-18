#!/usr/bin/env python3
"""Render a github-trending report (content JSON) into a self-contained HTML page.

The split of responsibilities is deliberate:

    agent  →  content.json   (what the report says — judgement, prose, numbers)
    script →  report.html    (how it looks — layout, charts, theme)

So changing the report's wording never touches this file, and changing the
layout never touches the content. See REPORT-CONTRACT.md for the contract.

Usage:
    python3 render_report.py content.json -o report.html
    python3 render_report.py content.json -o report.html --echarts vendor/echarts.min.js

ECharts is inlined so the output is a single file that works offline. If it is
missing, the error says exactly how to fetch it once.

Content JSON shape (every key is optional except `sections`):

    {
      "title": "GitHub AI 热点 · 周度趋势综合",
      "kind": "weekly",
      "generated_at": "2026-10-18T20:00:00+08:00",
      "source": "云端采集（data 分支）",
      "window": {"from": "...", "to": "...", "daysWithData": 2, "daysMissing": [...]},
      "trustworthy": false,
      "trustNote": "...",
      "kpis": [{"value": "2 / 7 天", "label": "实际有数据"}],
      "sections": [
        {"title": "一、社区在追什么", "blocks": [
          {"type": "chart",   "title": "1. 热点是什么", "charts": [...]},
          {"type": "cards",   "title": "2. 在解决什么问题", "items": [{"label": "...", "text": "..."}]},
          {"type": "table",   "title": "3. 和我的关系", "columns": [...], "rows": [...]},
          {"type": "stance",  "title": "二、...", "items": [{"name","progress","others","stance"}]},
          {"type": "actions", "title": "五、可以做什么", "items": [{"what","why","first"}]},
          {"type": "note",    "text": "..."}
        ]}
      ]
    }

A chart block looks like:

    {"charts": [
      {"id": "topics", "title": "话题出现次数", "unit": "次", "color": "acc",
       "data": [{"name": "claude-code", "value": 17}]}
    ]}
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys

DEFAULT_ECHARTS = os.path.expanduser(
    "~/.automation-state/github-trending/reports/vendor/echarts.min.js"
)
ECHARTS_HINT = (
    "curl -sSL https://registry.npmjs.org/echarts/-/echarts-6.1.0.tgz -o e.tgz && "
    "tar -xzf e.tgz && mkdir -p vendor && cp package/dist/echarts.min.js vendor/"
)

CSS = """
:root{--bg:#f6f7f9;--card:#fff;--ink:#15181e;--mute:#6b7280;--line:#e6e8ec;
--acc:#2f6bff;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0d0f13;--card:#171a20;--ink:#e9ecf1;
--mute:#98a0ab;--line:#262b34;--acc:#6ea0ff;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--ink);
font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
.wrap{max-width:960px;margin:0 auto}
h1{font-size:27px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}
h3{font-size:15px;margin:0 0 12px;color:var(--ink)}
.sub{color:var(--mute);font-size:13px;margin-bottom:24px}
.sec{background:var(--card);border:1px solid var(--line);border-radius:14px;
padding:24px 26px;margin-bottom:16px}
.block{margin-top:22px}
.block:first-of-type{margin-top:0}
.hint{font-size:12.5px;color:var(--mute);margin:0 0 12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));
gap:12px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px 19px}
.kpi .v{font-size:26px;font-weight:650;line-height:1.05;letter-spacing:-.02em}
.kpi .l{font-size:12px;color:var(--mute);margin-top:5px}
.badge{display:inline-block;padding:4px 11px;border-radius:999px;font-size:12px;font-weight:600}
.bad{background:rgba(220,38,38,.13);color:var(--bad)}
.ok{background:rgba(22,163,74,.13);color:var(--ok)}
.warn{background:rgba(217,119,6,.13);color:var(--warn)}
.note{font-size:12.5px;color:var(--mute);margin-top:14px;padding-left:13px;
border-left:2px solid var(--line)}
.chart{width:100%;height:300px}
.cards{display:grid;gap:11px}
.card{border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .lbl{font-size:13px;font-weight:600;margin-bottom:5px}
.card .txt{font-size:13.5px;color:var(--mute)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:9px 11px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-size:11.5px;font-weight:600;text-transform:uppercase;
letter-spacing:.04em}
tr:last-child td{border-bottom:none}
code{background:rgba(127,127,127,.13);padding:1.5px 6px;border-radius:5px;font-size:.9em}
.stance{display:grid;grid-template-columns:1fr 1fr;gap:11px}
@media(max-width:640px){.stance{grid-template-columns:1fr}}
.st{border:1px solid var(--line);border-radius:12px;padding:14px 16px;font-size:13px}
.st b{display:block;font-size:13px;margin-bottom:6px}
.st .who{color:var(--mute);font-size:12.5px}
.st.lead{border-color:var(--ok);background:rgba(22,163,74,.05)}
.st.sync{border-color:var(--acc);background:rgba(47,107,255,.05)}
.st.behind{border-color:var(--warn);background:rgba(217,119,6,.05)}
.st.nowhere{background:rgba(127,127,127,.04)}
.act{border:1px solid var(--line);border-radius:12px;padding:15px 17px;margin-bottom:11px}
.act .h{font-size:14px;font-weight:600;margin-bottom:7px}
.act .row{font-size:13px;color:var(--mute);margin-top:3px}
.act .row b{color:var(--ink);font-weight:600}
footer{color:var(--mute);font-size:12px;text-align:center;margin-top:30px}
"""

COLOURS = {"acc": "C.acc", "ok": "C.ok", "warn": "C.warn", "bad": "C.bad"}


def esc(value) -> str:
    return html.escape(str(value if value is not None else ""))


def render_chart_block(block: dict) -> str:
    out = []
    if block.get("title"):
        out.append(f"<h3>{esc(block['title'])}</h3>")
    for chart in block.get("charts", []):
        out.append(f'<div class="chart" id="{esc(chart["id"])}"></div>')
        if chart.get("hint"):
            out.append(f'<p class="hint">{esc(chart["hint"])}</p>')
    if block.get("note"):
        out.append(f'<div class="note">{esc(block["note"])}</div>')
    return "\n".join(out)


def render_cards_block(block: dict) -> str:
    out = []
    if block.get("title"):
        out.append(f"<h3>{esc(block['title'])}</h3>")
    items = "".join(
        f'<div class="card"><div class="lbl">{esc(i.get("label"))}</div>'
        f'<div class="txt">{esc(i.get("text"))}</div></div>'
        for i in block.get("items", [])
    )
    out.append(f'<div class="cards">{items}</div>')
    if block.get("note"):
        out.append(f'<div class="note">{esc(block["note"])}</div>')
    return "\n".join(out)


def render_table_block(block: dict) -> str:
    out = []
    if block.get("title"):
        out.append(f"<h3>{esc(block['title'])}</h3>")
    cols = block.get("columns", [])
    head = "".join(f"<th>{esc(c)}</th>" for c in cols)
    body = []
    for row in block.get("rows", []):
        cells = []
        for cell in row:
            text = esc(cell)
            if cell is None:
                text = '<span style="color:var(--mute)">没看到</span>'
            elif isinstance(cell, str) and cell.startswith("+"):
                text = f'<span style="color:var(--ok);font-weight:600">{text}</span>'
            cells.append(f"<td>{text}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    out.append(f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>")
    if block.get("note"):
        out.append(f'<div class="note">{esc(block["note"])}</div>')
    return "\n".join(out)


STANCE_CLASS = {
    "领先": "lead", "同步": "sync", "落后": "behind", "无人区": "nowhere",
}


def render_stance_block(block: dict) -> str:
    out = []
    if block.get("title"):
        out.append(f"<h3>{esc(block['title'])}</h3>")
    cards = []
    for item in block.get("items", []):
        cls = STANCE_CLASS.get(item.get("stance", ""), "nowhere")
        cards.append(
            f'<div class="st {cls}"><b>{esc(item.get("name"))}'
            f' · {esc(item.get("stance"))}</b>'
            f'<span class="who">我的进展：{esc(item.get("progress"))}<br>'
            f'山上有谁：{esc(item.get("others"))}</span></div>'
        )
    out.append(f'<div class="stance">{"".join(cards)}</div>')
    if block.get("note"):
        out.append(f'<div class="note">{esc(block["note"])}</div>')
    return "\n".join(out)


def render_actions_block(block: dict) -> str:
    out = []
    if block.get("title"):
        out.append(f"<h3>{esc(block['title'])}</h3>")
    for item in block.get("items", []):
        out.append(
            f'<div class="act"><div class="h">{esc(item.get("what"))}</div>'
            f'<div class="row"><b>为什么是现在：</b>{esc(item.get("why"))}</div>'
            f'<div class="row"><b>第一步：</b>{esc(item.get("first"))}</div></div>'
        )
    if not block.get("items"):
        out.append('<div class="note">今天没有值得动手的。</div>')
    return "\n".join(out)


def render_note_block(block: dict) -> str:
    return f'<div class="note">{esc(block.get("text"))}</div>'


BLOCK_RENDERERS = {
    "chart": render_chart_block,
    "cards": render_cards_block,
    "table": render_table_block,
    "stance": render_stance_block,
    "actions": render_actions_block,
    "note": render_note_block,
}


def build_html(content: dict, echarts_js: str) -> str:
    title = content.get("title") or "GitHub AI 热点"
    kind = content.get("kind") or "daily"
    window = content.get("window") or {}
    trustworthy = content.get("trustworthy", True)
    days_missing = window.get("daysMissing") or []

    parts = [
        "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        f"<title>{esc(title)}</title><style>{CSS}</style></head><body><div class=\"wrap\">",
        f"<h1>{esc(title)}</h1>",
    ]

    sub_bits = []
    if window:
        sub_bits.append(f"窗口 {esc(window.get('from'))} ~ {esc(window.get('to'))}")
    if content.get("source"):
        sub_bits.append(f"数据来源：{esc(content['source'])}")
    if window.get("daysWithData") is not None:
        sub_bits.append(f"有数据 {esc(window['daysWithData'])} 天")
    parts.append(f'<div class="sub">{" · ".join(sub_bits)}</div>')

    if content.get("kpis"):
        cards = "".join(
            f'<div class="kpi"><div class="v">{esc(k.get("value"))}</div>'
            f'<div class="l">{esc(k.get("label"))}</div></div>'
            for k in content["kpis"]
        )
        parts.append(f'<div class="kpis">{cards}</div>')

    gate_class = "ok" if trustworthy else "bad"
    gate_text = "趋势判断可信" if trustworthy else "数据门禁：不足以判断趋势"
    missing = (
        f' <span class="badge warn">缺失 {len(days_missing)} 天</span>'
        if days_missing else ""
    )
    gate_body = f'<span class="badge {gate_class}">{gate_text}</span>{missing}'
    if content.get("trustNote"):
        gate_body += f'<div class="note">{esc(content["trustNote"])}</div>'
    parts.append(f'<div class="sec">{gate_body}</div>')

    for section in content.get("sections", []):
        body = [f"<h2>{esc(section.get('title'))}</h2>"]
        for block in section.get("blocks", []):
            renderer = BLOCK_RENDERERS.get(block.get("type"))
            if renderer is None:
                continue
            body.append(f'<div class="block">{renderer(block)}</div>')
        parts.append(f'<div class="sec">{"".join(body)}</div>')

    parts.append(
        f'<footer>生成于 {esc(content.get("generated_at"))} · '
        f"报告结构见 REPORT-CONTRACT.md</footer></div>"
    )

    # Charts are declared here, after the data is known to the page.
    chart_defs = [
        {"id": c["id"], "data": c.get("data", []), "unit": c.get("unit", ""),
         "colour": COLOURS.get(c.get("color", "acc"), "C.acc")}
        for section in content.get("sections", [])
        for block in section.get("blocks", [])
        if block.get("type") == "chart"
        for c in block.get("charts", [])
    ]

    parts.append(f"<script>{echarts_js}</script>")
    parts.append("<script>")
    parts.append(f"var K={json.dumps(kind)};var D={json.dumps(chart_defs, ensure_ascii=False)};")
    parts.append("""
var dark=matchMedia('(prefers-color-scheme:dark)').matches;
var C=dark?{ink:'#e9ecf1',mute:'#98a0ab',line:'#262b34',acc:'#6ea0ff',ok:'#4ade80',warn:'#fbbf24',bad:'#f87171'}
         :{ink:'#15181e',mute:'#6b7280',line:'#e6e8ec',acc:'#2f6bff',ok:'#16a34a',warn:'#d97706',bad:'#dc2626'};
var charts=[];
D.forEach(function(c){
  var el=document.getElementById(c.id);
  if(!el)return;
  var chart=echarts.init(el);
  var minH=Math.max(200, c.data.length*30+40);
  el.style.height=minH+'px';
  chart.setOption({
    grid:{left:Math.min(200,Math.max(90,c.data.reduce(function(m,d){
      return Math.max(m,String(d.name).length*8+20);},0))),right:70,top:10,bottom:10},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},
      backgroundColor:dark?'#1f232b':'#fff',borderColor:C.line,
      textStyle:{color:C.ink,fontSize:12}},
    xAxis:{type:'value',splitLine:{lineStyle:{color:C.line}},
      axisLabel:{color:C.mute,fontSize:11}},
    yAxis:{type:'category',inverse:true,data:c.data.map(function(d){return d.name;}),
      axisLine:{show:false},axisTick:{show:false},
      axisLabel:{color:C.ink,fontSize:12}},
    series:[{type:'bar',data:c.data.map(function(d){return d.value;}),
      itemStyle:{color:eval(c.colour),borderRadius:[0,5,5,0]},barWidth:'60%',
      label:{show:true,position:'right',color:C.mute,fontSize:11,
        formatter:'{c}'+(c.unit?' '+c.unit:'')}}]
  });
  chart.resize();charts.push(chart);
});
addEventListener('resize',function(){charts.forEach(function(c){c.resize();});});
""")
    parts.append("</script></body></html>")
    return "\n".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a github-trending report to HTML.")
    parser.add_argument("content", help="content JSON file")
    parser.add_argument("-o", "--output", required=True, help="output .html path")
    parser.add_argument(
        "--echarts",
        default=DEFAULT_ECHARTS,
        help=f"path to echarts.min.js (default: {DEFAULT_ECHARTS})",
    )
    args = parser.parse_args()

    if not os.path.isfile(args.echarts):
        print(
            f"error: echarts not found at {args.echarts}\n"
            f"fetch it once (in the output directory):\n  {ECHARTS_HINT}",
            file=sys.stderr,
        )
        return 2

    with open(args.content, encoding="utf-8") as fh:
        content = json.load(fh)
    with open(args.echarts, encoding="utf-8") as fh:
        echarts_js = fh.read()

    page = build_html(content, echarts_js)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(page)

    size = os.path.getsize(args.output)
    print(f"wrote {args.output}  ({size / 1024 / 1024:.2f} MB, echarts inlined)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
