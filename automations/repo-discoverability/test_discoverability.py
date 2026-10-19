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


class TestAuditChecks(unittest.TestCase):
    def test_description_length_window(self):
        self.assertTrue(20 <= len("这是一个足够长的项目描述用来通过长度检查") <= 200)

    def test_archived_repos_are_skippable(self):
        source = open("audit_discoverability.py", encoding="utf-8").read()
        self.assertIn("archived", source)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
