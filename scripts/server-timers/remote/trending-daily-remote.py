#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""github-trending-daily — server side of the two-stage pipeline.

stdin: the scan.py payload pushed by GitHub Actions (kind=github-trending-daily)
stdout: {"ok":true,"changed":bool,"report":url,"summary":"..."}

Stage 1 (deterministic): fingerprint the candidates; same day + same fingerprint
=> nothing to do, no model call.
Stage 2 (only when changed): `dsh headless` turns the neutral candidate list
into report content (this is where DeepSeek is used), the HTML is published under
https://automation.bamamei.online/reports/github-trending-daily/<date>.html and
one inbox row is written.
"""
import json
import os
import sys

from common import (TZ, deliver, emit, fingerprint, load_state, mode_forced,
                    publish_html, read_payload, report_url, render_page, run_dsh,
                    parse_json, save_state)
from datetime import datetime

TASK = "github-trending-daily"

PROMPT = """你是 GitHub 趋势分析员。下面是今天云端采集到的中性候选清单（JSON）。
按固定结构产出报告内容，只输出 JSON，不要解释、不要 markdown 代码块：

{
  "summary": "一句话概览（<=80 字）",
  "sections": [
    {"heading": "一、社区在追什么", "paragraphs": ["…"], "bullets": ["repo（+stars）：一句话"]},
    {"heading": "二、我在做的事，谁也在做", "paragraphs": ["…"]},
    {"heading": "三、我收的项目，现在怎么样", "paragraphs": ["…"]},
    {"heading": "四、dsh-plugin 生态", "paragraphs": ["…"]},
    {"heading": "五、可以做什么", "paragraphs": ["…"]}
  ],
  "skills": ["如果发现可用 Skill，写名字；没有就空数组"]
}

规则：
- 只写数据里出现过的仓库，不要编造；数据缺失就在对应段落说明。
- 「已有项目」指候选里和用户已收录项目重合的部分；无法判断就说不知道。
- 只产出报告内容；不要写任何飞书表（收录与落库都必须人工确认）。
- 汇报语气克制，给事实和判断，不要营销腔。
"""


def main():
    payload = read_payload(TASK)
    now = datetime.now(TZ)
    date = payload.get("generated_at", "")[:10] or now.strftime("%Y-%m-%d")
    try:
        date = datetime.fromisoformat(payload["generated_at"]).astimezone(TZ).strftime("%Y-%m-%d")
    except Exception:
        pass

    candidates = payload.get("candidates") or []
    signal = {
        "candidates": sorted("%s|%s|%s" % (c.get("repo"), c.get("stars"), c.get("gain"))
                             for c in candidates if c.get("repo")),
        "topics": sorted("%s|%s" % (t.get("topic"), t.get("repos"))
                         for t in payload.get("topic_frequency") or []),
    }
    digest = fingerprint(signal)
    state = load_state(TASK)
    if not mode_forced() and state.get("date") == date and state.get("hash") == digest:
        emit({"ok": True, "changed": False, "skipped": "unchanged", "candidates": len(candidates)})
        return 0
    if not candidates:
        deliver(TASK, "%s github-trending-daily：云端无候选数据，跳过" % date, "失败")
        emit({"ok": False, "error": "empty candidates", "changed": False})
        return 3

    prompt = PROMPT + "\n\n数据：\n" + json.dumps(payload, ensure_ascii=False)[:24000]
    out, err = run_dsh(prompt)
    content = parse_json(out)
    if content is None:
        deliver(TASK, "%s github-trending-daily：模型输出无法解析（前 80 字：%s）" % (date, out.strip()[:80]),
                "失败")
        emit({"ok": False, "error": "unparsable model output", "stderr": err[:300]})
        return 3

    summary = str(content.get("summary") or "")[:80]
    html = render_page("GitHub AI 热点 · 每日", date, summary, content.get("sections") or [])
    publish_html(TASK, date, html)
    url = report_url(TASK, date)

    save_state(TASK, {"date": date, "hash": digest, "candidates": len(candidates)})
    deliver(TASK, "%s github-trending-daily：%s" % (date, summary), "成功", url)
    emit({"ok": True, "changed": True, "report": url, "summary": summary,
          "candidates": len(candidates), "skills": content.get("skills") or []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
