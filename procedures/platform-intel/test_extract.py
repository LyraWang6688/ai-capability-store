#!/usr/bin/env python3
"""Offline tests: no network, no credentials."""
import importlib.util
import os
import pathlib
import unittest

MODULE = pathlib.Path(__file__).with_name("extract.py")
spec = importlib.util.spec_from_file_location("extract", MODULE)
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class ParseRssTest(unittest.TestCase):
    def test_extracts_title_and_description(self):
        xml = """<?xml version="1.0"?><rss><channel>
        <item><title><![CDATA[豆包工作上线目标模式]]></title>
          <description>先给计划，确认后才干活</description>
          <pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item>
        <item><title>无描述条目</title></item>
        </channel></rss>"""
        items = watch.parse_rss(xml)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["title"], "豆包工作上线目标模式")
        self.assertIn("确认后才干活", items[0]["description"])
        self.assertEqual(items[1]["description"], "")

    def test_ignores_items_without_title(self):
        self.assertEqual(watch.parse_rss("<rss><item><description>x</description></item></rss>"), [])


class StripHtmlTest(unittest.TestCase):
    def test_removes_tags_and_collapses_space(self):
        self.assertEqual(watch.strip_html("<p>a</p><b>b</b>"), "a b")


class DoubaoNewsTest(unittest.TestCase):
    def test_failing_sources_degrade_to_empty(self):
        original = watch.fetch
        try:
            watch.fetch = lambda url: (_ for _ in ()).throw(RuntimeError("blocked"))
            self.assertEqual(watch.doubao_news({"sources": {"doubao": ["https://example.invalid/rss"]}}), "")
        finally:
            watch.fetch = original


if __name__ == "__main__":
    unittest.main(verbosity=2)
