#!/usr/bin/env python3
"""Offline tests: no network, no credentials."""
import importlib.util
import os
import pathlib
import unittest

MODULE = pathlib.Path(__file__).with_name("watch.py")
spec = importlib.util.spec_from_file_location("watch", MODULE)
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


class NotificationTest(unittest.TestCase):
    def test_empty_batch_has_no_message(self):
        self.assertIsNone(watch.format_notification([], "https://example"))

    def test_message_lists_features_and_caps_at_eight(self):
        items = [{"feature": f"功能{i}", "tool": "Claude", "priority": "高"} for i in range(10)]
        text = watch.format_notification(items, "https://example/base")
        self.assertIn("新增 10 条", text)
        self.assertIn("功能0", text)
        self.assertIn("…还有 2 条", text)
        self.assertIn("https://example/base", text)

    def test_notify_dm_without_chat_is_false(self):
        self.assertFalse(watch.notify_dm("", "hello"))


class DeliverNotificationTest(unittest.TestCase):
    def test_no_channel_returns_none(self):
        original = dict(os.environ)
        try:
            os.environ.pop("FEISHU_NOTIFY_CHAT_ID", None)
            os.environ.pop("FEISHU_NOTIFY_WEBHOOK", None)
            self.assertEqual(watch.deliver_notification({}, "hi"), "none")
        finally:
            os.environ.clear()
            os.environ.update(original)

    def test_dm_success_reports_dm(self):
        original = dict(os.environ)
        original_dm = watch.notify_dm
        try:
            os.environ["FEISHU_NOTIFY_CHAT_ID"] = "oc_test"
            watch.notify_dm = lambda chat_id, text: True
            self.assertEqual(watch.deliver_notification({}, "hi"), "dm")
        finally:
            watch.notify_dm = original_dm
            os.environ.clear()
            os.environ.update(original)

    def test_dm_failure_reports_failed(self):
        original = dict(os.environ)
        original_dm = watch.notify_dm
        try:
            os.environ["FEISHU_NOTIFY_CHAT_ID"] = "oc_test"
            watch.notify_dm = lambda chat_id, text: False
            self.assertEqual(watch.deliver_notification({}, "hi"), "failed")
        finally:
            watch.notify_dm = original_dm
            os.environ.clear()
            os.environ.update(original)


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
