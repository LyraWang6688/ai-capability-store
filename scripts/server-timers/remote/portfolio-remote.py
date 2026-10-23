#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""github-portfolio-snapshot — server side of the two-stage pipeline.

stdin: the normalized repo payload pushed by GitHub Actions
        (kind=github-portfolio-snapshot, produced by snapshot.py --emit)
stdout: {"ok":true,"changed":bool,"summary":"..."}

This task is deterministic by default (no model call): the repository set and
field fingerprint decide whether anything changed, and `dsh headless` writes the
rows through lark-cli. A model is only consulted when COMMENTARY=1.
"""
import json
import os
import sys
from datetime import datetime

from common import (TZ, deliver, emit, fail, fingerprint, load_env, load_state, mode_forced,
                    parse_json, read_payload, run_dsh, save_state)

TASK = "github-portfolio-snapshot"
FIELDS = {
    "base_env": "PM_BASE_TOKEN",
    "history_table": "Repo Snapshot History",
    "runs_table": "Snapshot Runs",
    "deleted_table": "Deleted Repos",
}

PROMPT = """你是仓库资产管理员。下面是本月 GitHub 仓库快照（JSON，每个元素是一个已归一化的仓库）。
请用 lark-cli（--as bot）把结果写入飞书「项目管理」Base：

1. 先 `lark-cli base +table-list --base-token $PM_BASE_TOKEN` 找到这三张表：
   Repo Snapshot History / Snapshot Runs / Deleted Repos（找不到就新建，字段按语义补齐）。
2. 幂等键是 snapshot_period（YYYY-MM，从 JSON 的 generated_at 取）：已存在就更新，不要重复插。
3. Repo Snapshot History：每个仓库一行，写名字、仓库 id、stars、pushed_at、archived、
   topics 数、discoverability 等字段（以表的实际字段为准，没有的跳过）。
4. Snapshot Runs：本次一条汇总（period、仓库数、新增数、消失数、时间）。
5. Deleted Repos：本次消失的仓库各一行。

最后只输出 JSON：{"summary":"一句话（<=80字）","added":N,"removed":N,"drifted":N,"skills":["可用 Skill"]}
不要输出其他内容。数据：
"""


def main():
    payload = read_payload(TASK)
    repos = payload.get("repos") or []
    date = (payload.get("generated_at") or "")[:10] or datetime.now(TZ).strftime("%Y-%m-%d")
    period = date[:7]
    signal = {"period": period,
              "repos": sorted("%s|%s|%s|%s" % (r.get("repo_name"), r.get("stars"),
                                               r.get("pushed_at"), r.get("archived")) for r in repos)}
    digest = fingerprint(signal)
    state = load_state(TASK)
    if not mode_forced() and state.get("hash") == digest and state.get("period") == period:
        emit({"ok": True, "changed": False, "skipped": "unchanged"})
        return 0
    if not repos:
        deliver(TASK, "%s github-portfolio-snapshot：快照为空，跳过" % period, "失败")
        emit({"ok": False, "error": "empty repos"})
        return 3

    prompt = PROMPT + json.dumps({"generated_at": payload.get("generated_at"),
                                  "login": payload.get("login"),
                                  "repos": repos}, ensure_ascii=False)[:60000]
    out, err = run_dsh(prompt)
    content = parse_json(out)
    if content is None:
        deliver(TASK, "%s 仓库快照：模型输出无法解析（前 80 字：%s）" % (period, out.strip()[:80]), "失败")
        emit({"ok": False, "error": "unparsable model output", "stderr": err[:300]})
        return 3

    summary = str(content.get("summary") or "")[:80] or "%s 仓库快照完成：%d 个仓库" % (period, len(repos))
    save_state(TASK, {"period": period, "hash": digest, "repos": len(repos)})
    deliver(TASK, "%s github-portfolio-snapshot：%s" % (period, summary), "成功")
    emit({"ok": True, "changed": True, "summary": summary, "repos": len(repos),
          "added": content.get("added"), "removed": content.get("removed"),
          "skills": content.get("skills") or []})
    return 0


if __name__ == "__main__":
    sys.exit(main())
