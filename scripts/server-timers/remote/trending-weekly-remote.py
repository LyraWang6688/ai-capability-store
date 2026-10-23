#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""github-trending-weekly — server side of the two-stage pipeline.

stdin: the aggregate.py payload pushed by GitHub Actions (kind=github-trending-weekly)
stdout: {"ok":true,"changed":bool,"report":url,"summary":"..."}
"""
import json
import sys
from datetime import datetime

from common import (TZ, deliver, emit, fingerprint, load_state, mode_forced, parse_json,
                    publish_html, read_payload, report_url, render_page, run_dsh, save_state)

TASK = "github-trending-weekly"

PROMPT = """你是 GitHub 趋势分析员。下面是本周聚合数据（JSON：topic_frequency、
repos_sustained、repos_climbing_by_stars、repos_one_day_wonders 等）。
按契约的「周报的差异」做跨周判断，只输出 JSON，不要解释、不要 markdown 代码块：

{
  "summary": "一句话本周概览（<=80 字）",
  "sections": [
    {"heading": "一、社区在追什么", "paragraphs": ["…"], "bullets": ["…"]},
    {"heading": "二、我在做的事，谁也在做", "paragraphs": ["…"]},
    {"heading": "三、我收的项目，现在怎么样", "paragraphs": ["…"]},
    {"heading": "四、dsh-plugin 生态", "paragraphs": ["…"]},
    {"heading": "五、可以做什么", "paragraphs": ["…"]}
  ],
  "skills": ["如果发现可用 Skill，写名字；没有就空数组"]
}

规则：只讲数据里出现过的项目，不编造；跨周变化要说清「从哪天到哪天」；
不要写飞书收录表（收录必须人工确认）。
"""


def main():
    payload = read_payload(TASK)
    date = datetime.now(TZ).strftime("%Y-%m-%d")
    signal = {
        "topics": sorted("%s|%s" % (t.get("topic"), t.get("total_repo_sightings"))
                         for t in payload.get("topic_frequency") or []),
        "sustained": sorted(r.get("repo") for r in payload.get("repos_sustained") or [] if r.get("repo")),
        "climbing": sorted(r.get("repo") for r in payload.get("repos_climbing_by_stars") or [] if r.get("repo")),
    }
    digest = fingerprint(signal)
    state = load_state(TASK)
    if not mode_forced() and state.get("hash") == digest and state.get("week"):
        emit({"ok": True, "changed": False, "skipped": "unchanged"})
        return 0
    if not (payload.get("topic_frequency") or payload.get("repos_sustained")):
        deliver(TASK, "%s github-trending-weekly：本周聚合为空，跳过" % date, "失败")
        emit({"ok": False, "error": "empty aggregate", "changed": False})
        return 3

    prompt = PROMPT + "\n\n数据：\n" + json.dumps(payload, ensure_ascii=False)[:24000]
    out, err = run_dsh(prompt)
    content = parse_json(out)
    if content is None:
        deliver(TASK, "%s github-trending-weekly：模型输出无法解析（前 80 字：%s）" % (date, out.strip()[:80]),
                "失败")
        emit({"ok": False, "error": "unparsable model output", "stderr": err[:300]})
        return 3

    summary = str(content.get("summary") or "")[:80]
    html = render_page("GitHub AI 热点 · 周度趋势综合", date, summary, content.get("sections") or [])
    publish_html(TASK, date, html)
    url = report_url(TASK, date)
    week = datetime.now(TZ).isocalendar()
    save_state(TASK, {"week": "%s-W%s" % (week[0], week[1]), "date": date, "hash": digest})
    deliver(TASK, "%s github-trending-weekly：%s" % (date, summary), "成功", url)
    emit({"ok": True, "changed": True, "report": url, "summary": summary,
          "skills": content.get("skills") or []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
