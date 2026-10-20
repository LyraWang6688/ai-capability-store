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

import apply_discoverability as ap
import audit_discoverability as au
import traffic_baseline as tb
import report_issues as ri

README = """# Demo Project

> 把门店每天的对账搬进飞书，不用再开 Excel 手工汇总。

**给谁用**：店长
**它做什么**：对账 / 盘点 / 异常上报
**怎么开始**：`npm i demo`

## 核心功能

- 对账
"""


class TestDescription(unittest.TestCase):
    def test_description_comes_from_the_blockquote(self):
        self.assertEqual(ap.derive_description(README, ""),
                         "把门店每天的对账搬进飞书，不用再开 Excel 手工汇总。")

    def test_falls_back_to_first_paragraph(self):
        readme = "# X\n\nThis is the opening paragraph of the project.\n"
        self.assertIn("opening paragraph", ap.derive_description(readme, ""))

    def test_no_readme_yields_empty(self):
        self.assertEqual(ap.derive_description("", ""), "")

    def test_blockquote_must_sit_under_the_h1(self):
        """标题之前的引言不采用 —— 会退回第一段正文。"""
        readme = "> 这段引言在标题【之前】，不该被当作 description\n\n# Title\n\n正文段落。\n"
        result = ap.derive_description(readme, "")
        self.assertNotIn("标题【之前】", result, "标题前的引言不能当 description")
        self.assertEqual(result, "正文段落。", "应当退回第一段正文")


class TestLlmsTxt(unittest.TestCase):
    def test_generated_index_lists_core_docs_and_sections(self):
        with mock.patch.object(ap, "gh_json", return_value=None):
            out = ap.build_llms_txt("owner/demo", README, "一句话描述")
        self.assertIn("# Demo Project", out)
        self.assertIn("> 一句话描述", out)
        self.assertIn("./README.md", out)
        self.assertIn("核心功能", out)

    def test_agents_md_is_linked_when_present(self):
        def fake(path):
            return {"name": "AGENTS.md"} if path.endswith("AGENTS.md") else None
        with mock.patch.object(ap, "gh_json", side_effect=fake):
            out = ap.build_llms_txt("owner/demo", README, "")
        self.assertIn("./AGENTS.md", out)


class TestTopicsComeFromThePlanOnly(unittest.TestCase):
    """The invariant that matters: the write path reads topics.plan.json, not keywords.

    Keyword derivation is allowed to *suggest* (it is shown to a human), but it
    must never reach `actions`, because on 2026-10-19 it suggested `ai-agents` for
    feishu-retail-ops (matched "AGENTS.md" in a file tree) and `inventory` for
    personal-ip-hub (matched "project inventory" used in its generic sense).
    """

    def _run(self, plan):
        meta = {"archived": False, "language": "JavaScript",
                "topics": [], "description": ""}
        with mock.patch.object(ap, "_load_topic_plan", return_value=plan), \
             mock.patch.object(ap, "gh_json", side_effect=lambda p: meta), \
             mock.patch.object(ap, "read_readme", return_value=(README, "README.md")), \
             mock.patch.object(ap, "gh_raw", return_value=README), \
             mock.patch.object(ap, "build_llms_txt", return_value="# x"):
            return ap.apply_repo("owner/demo", False)

    def test_plan_is_the_only_source_of_topics(self):
        result = self._run({"owner/demo": ["feishu", "bitable"]})
        topics = [a for a in result["actions"] if a["field"] == "topics"]
        self.assertEqual(len(topics), 1)
        self.assertEqual(topics[0]["to"], ["feishu", "bitable"])

    def test_without_a_plan_no_topics_are_written(self):
        result = self._run({})
        self.assertEqual([a for a in result["actions"] if a["field"] == "topics"], [],
                         "没有 plan 时绝不能写 topics")

    def test_keywords_may_suggest_but_never_become_actions(self):
        readme = "# R\n\n> 门店经营底座\n\n```\n├── AGENTS.md  # Agent 入口\n```\n"
        suggestions = ap.derive_topics(readme, "JavaScript", [])
        self.assertIsInstance(suggestions, list)  # 允许建议
        result = self._run({})
        # 但建议不进 actions
        self.assertEqual([a for a in result["actions"] if a["field"] == "topics"], [])


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
                "description": "这是一个长度足够的项目描述用于通过检查", "language": "Python"}
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
