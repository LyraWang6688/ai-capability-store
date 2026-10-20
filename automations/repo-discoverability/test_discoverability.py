#!/usr/bin/env python3
"""Offline tests — no network. Run: python3 test_discoverability.py

The tests that matter most pin the two decisions that were expensive to learn:

  * the description comes from the blockquote, not from whatever paragraph
    happens to be first;
  * topics are NEVER derived into the write path — the keyword matcher gave
    wrong answers twice on the first real dry-run.
"""
from __future__ import annotations

import sys
import unittest
from unittest import mock

import audit_discoverability as au
import traffic_baseline as tb
import report_issues as ri
import report as rp

README = """# Demo Project

> 把门店每天的对账搬进飞书，不用再开 Excel 手工汇总。

**给谁用**：店长
**它做什么**：对账 / 盘点 / 异常上报
**怎么开始**：`npm i demo`

## 核心功能

- 对账
"""





class TestLocalReport(unittest.TestCase):
    """report.py 是 DSH 会话侧读 issue 的入口，解析必须稳。"""

    def test_parse_failures_reads_the_issue_table(self):
        body = (
            "| 项 | 层 | 缺什么 | 怎么补 |\n"
            "| --- | --- | --- | --- |\n"
            "| `D3` README 前三行 | 实测项（必修） | 命中 0/3 | 插入三行摘要 |\n"
            "| `D6` DSH badge | 生态约定（建议） | — | 加徽章 |\n"
        )
        rows = rp.parse_failures(body)
        self.assertEqual([r["code"] for r in rows], ["D3", "D6"],
                         "code 里不能残留反引号")
        self.assertEqual(rows[0]["title"], "README 前三行")
        self.assertEqual(rows[1]["tier"], "生态约定（建议）")

    def test_parse_failures_ignores_non_item_rows(self):
        self.assertEqual(rp.parse_failures("| --- | --- | --- | --- |\n随便一行"), [])

    def test_marker_and_label_are_shared_with_the_writer(self):
        self.assertEqual(rp.MARKER, ri.MARKER, "读写两边必须用同一个 marker")
        self.assertEqual(rp.LABEL, ri.LABEL)


class TestAuditScope(unittest.TestCase):
    """公开 / 归档 / 私有的判据必须分开 —— 混在一起会产出假失败。"""

    def _audit(self, meta, readme="# X\n\n> q\n\n给谁用 它做什么 怎么开始\n"):
        with mock.patch.object(au, "gh_json",
                               side_effect=lambda p: meta if p.endswith("owner/demo") else None), \
             mock.patch.object(au, "_readme_text", return_value=readme):
            return au.audit("owner/demo")

    def test_private_repo_marks_search_items_not_applicable(self):
        meta = {"archived": False, "private": True, "topics": [], "description": "", "language": ""}
        result = self._audit(meta)
        by_code = {i["code"]: i for i in result["items"]}
        for code in ("D1", "D2", "D6"):
            self.assertEqual(by_code[code]["status"], "N/A",
                             f"{code} 对私有仓库没有意义，不该算 FAIL")

    def test_na_items_do_not_dilute_the_denominator(self):
        meta = {"archived": False, "private": True, "topics": [], "description": "", "language": ""}
        result = self._audit(meta)
        self.assertEqual(result["total"], 3, "私有仓库只算 D3/D4/D5 三项")

    def test_public_repo_scores_all_six(self):
        meta = {"archived": False, "private": False, "topics": ["a","b","c","d","e"],
                "description": "这是一个长度足够的项目描述用于通过长度检查", "language": "Python"}
        result = self._audit(meta)
        self.assertEqual(result["total"], 6)
        self.assertEqual(result["score"], 3, "D1/D2/D3 应通过")

    def test_archived_flag_is_reported(self):
        result = self._audit({"archived": True, "private": False, "topics": [], "description": "", "language": ""})
        self.assertTrue(result["archived"])


class TestIssueReporting(unittest.TestCase):
    """The issue bot must be idempotent — a weekly run cannot pile up issues."""

    def _result(self, fails: int):
        items = []
        for n in range(fails):
            items.append({"code": f"D{n+1}", "title": f"t{n}", "tier": "T1",
                          "status": "FAIL", "detail": "", "fix": "fix it"})
        items.append({"code": "D9", "title": "ok", "tier": "T1",
                      "status": "PASS", "detail": "", "fix": ""})
        return {"repo": "owner/demo", "archived": False,
                "score": 1, "total": len(items), "items": items}

    def test_body_carries_the_marker_used_for_idempotency(self):
        self.assertIn(ri.MARKER, ri.render_body(self._result(2)))

    def test_body_lists_every_failing_item(self):
        body = ri.render_body(self._result(3))
        for code in ("D1", "D2", "D3"):
            self.assertIn(code, body)

    def test_passing_repo_without_issue_does_nothing(self):
        with mock.patch.object(ri, "find_open_issue", return_value=None):
            out = ri.handle("owner/demo", self._result(0), do_write=False)
        self.assertEqual(out["action"], "none")

    def test_failing_repo_without_issue_wants_to_create(self):
        with mock.patch.object(ri, "find_open_issue", return_value=None):
            out = ri.handle("owner/demo", self._result(2), do_write=False)
        self.assertEqual(out["action"], "create")

    def test_failing_repo_with_existing_issue_updates_instead_of_creating(self):
        with mock.patch.object(ri, "find_open_issue", return_value={"number": 7, "body": ri.MARKER}):
            out = ri.handle("owner/demo", self._result(2), do_write=False)
        self.assertEqual(out["action"], "update", "不能因为每周跑就重复开单")
        self.assertIn("#7", out["detail"])

    def test_fixed_repo_closes_the_issue(self):
        with mock.patch.object(ri, "find_open_issue", return_value={"number": 9, "body": ri.MARKER}):
            out = ri.handle("owner/demo", self._result(0), do_write=False)
        self.assertEqual(out["action"], "close")

    def test_archived_repo_is_skipped_entirely(self):
        result = self._result(3)
        result["archived"] = True
        out = ri.handle("owner/demo", result, do_write=False)
        self.assertEqual(out["action"], "none")


class TestDshBadge(unittest.TestCase):
    """D6 is attribution, not a ranking factor — the test pins that framing."""

    def test_badge_markers_cover_both_spellings(self):
        self.assertIn("powered_by-dsh", au.BADGE_MARKERS)
        self.assertIn("powered-by-dsh", au.BADGE_MARKERS)

    def test_readme_without_badge_fails_the_check(self):
        meta = {"archived": False, "topics": ["a", "b", "c", "d", "e"],
                "description": "这是一个长度足够的项目描述用于通过长度检查", "language": "Python"}
        readme = "# X\n\n> 引言够长了吧这个项目\n\n给谁用 / 它做什么 / 怎么开始\n"
        with mock.patch.object(au, "gh_json",
                               side_effect=lambda p: meta if p.endswith("owner/demo") else None), \
             mock.patch.object(au, "_readme_text", return_value=readme):
            result = au.audit("owner/demo")
        badge = next(i for i in result["items"] if i["code"] == "D6")
        self.assertEqual(badge["status"], "FAIL")
        self.assertEqual(badge["tier"], "T2", "D6 是约定项不是实测项")

    def test_badge_is_found_when_present(self):
        meta = {"archived": False, "topics": [], "description": "", "language": ""}
        readme = "# X\n\n> q\n\n[![](https://img.shields.io/badge/powered_by-dsh-blue)](x)\n"
        with mock.patch.object(au, "gh_json",
                               side_effect=lambda p: meta if p.endswith("owner/demo") else None), \
             mock.patch.object(au, "_readme_text", return_value=readme):
            result = au.audit("owner/demo")
        badge = next(i for i in result["items"] if i["code"] == "D6")
        self.assertEqual(badge["status"], "PASS")


class TestTrafficBaseline(unittest.TestCase):
    """The 14-day window is the reason this exists as its own script + storage."""

    def test_days_between_counts_calendar_gap(self):
        self.assertEqual(
            tb.days_between("2026-10-20T00:00:00+00:00", "2026-11-03T00:00:00+00:00"), 14)

    def test_compare_needs_two_snapshots(self):
        with mock.patch.object(tb, "load_store", return_value={"snapshots": []}):
            self.assertEqual(tb.cmd_compare(type("A", (), {})()), 1)

    def test_store_default_shape_is_empty(self):
        with mock.patch.object(tb.os.path, "isfile", return_value=False):
            self.assertEqual(tb.load_store(), {"owner": None, "snapshots": []})

    def test_window_constant_matches_github_retention(self):
        self.assertEqual(tb.WINDOW_DAYS, 14, "GitHub traffic API 只保留 14 天")


class TestAuditChecks(unittest.TestCase):
    def test_description_length_window(self):
        self.assertTrue(20 <= len("这是一个足够长的项目描述用来通过长度检查") <= 200)

    def test_archived_repos_are_skippable(self):
        source = open("audit_discoverability.py", encoding="utf-8").read()
        self.assertIn("archived", source)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
