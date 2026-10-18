"""Smoke tests for render_report.py — the layout half of the report split.

The contract (REPORT-CONTRACT.md) says what the report must say; this module
only turns that content into HTML. These tests pin the boundary: every block
type renders, unknown types are skipped instead of crashing, and the output is
a single self-contained file.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import render_report  # noqa: E402

MINIMAL = {
    "title": "测试报告",
    "kind": "weekly",
    "generated_at": "2026-10-18 20:00",
    "source": "云端采集（data 分支）",
    "window": {"from": "2026-10-12", "to": "2026-10-18",
               "daysWithData": 2, "daysMissing": ["2026-10-12"]},
    "trustworthy": False,
    "trustNote": "数据不足",
    "kpis": [{"value": "2 / 7 天", "label": "实际有数据"}],
    "sections": [{
        "title": "一、社区在追什么",
        "blocks": [
            {"type": "chart", "title": "1. 热点是什么", "charts": [
                {"id": "c1", "color": "acc", "unit": "次",
                 "data": [{"name": "mcp", "value": 5}]}]},
            {"type": "cards", "title": "2. 在解决什么问题",
             "items": [{"label": "mcp", "text": "接法不统一"}]},
            {"type": "table", "title": "3. 和我的关系",
             "columns": ["话题", "方向"], "rows": [["mcp", "+1"]]},
            {"type": "stance", "title": "二、谁也在做",
             "items": [{"name": "方向A", "stance": "领先",
                        "progress": "有", "others": "没看到"}]},
            {"type": "actions", "title": "五、可以做什么",
             "items": [{"what": "做X", "why": "现在做", "first": "第一步"}]},
            {"type": "note", "text": "一条说明"},
            {"type": "unknown-type", "title": "应被忽略"},
        ],
    }],
}


class TestRenderReport(unittest.TestCase):
    def _page(self):
        return render_report.build_html(MINIMAL, "/* echarts stub */")

    def test_is_a_single_self_contained_document(self):
        page = self._page()
        self.assertTrue(page.startswith("<!DOCTYPE html>"))
        self.assertIn("</html>", page)
        # ECharts is inlined, so no external script/style references are needed.
        self.assertNotIn("<script src=", page)
        self.assertNotIn("<link rel=", page)

    def test_every_block_type_renders(self):
        page = self._page()
        for marker in ('id="c1"', 'class="card"', "<table>", 'class="st lead"',
                       'class="act"', 'class="note"'):
            self.assertIn(marker, page)

    def test_unknown_block_type_is_skipped_not_fatal(self):
        page = self._page()
        self.assertNotIn("应被忽略", page)
        self.assertIn("一、社区在追什么", page)

    def test_untrustworthy_data_is_badged_prominently(self):
        page = self._page()
        self.assertIn("数据门禁：不足以判断趋势", page)
        self.assertIn("缺失 1 天", page)

    def test_html_in_content_is_escaped(self):
        content = json.loads(json.dumps(MINIMAL))
        content["title"] = "<script>alert(1)</script>"
        page = render_report.build_html(content, "")
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;", page)

    def test_cli_errors_clearly_when_echarts_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            content_path = os.path.join(tmp, "c.json")
            with open(content_path, "w", encoding="utf-8") as fh:
                json.dump(MINIMAL, fh)
            completed = subprocess.run(
                [sys.executable, os.path.join(HERE, "render_report.py"),
                 content_path, "-o", os.path.join(tmp, "out.html"),
                 "--echarts", os.path.join(tmp, "nope.js")],
                capture_output=True, text=True,
            )
            self.assertEqual(completed.returncode, 2)
            self.assertIn("echarts not found", completed.stderr)
            self.assertIn("registry.npmjs.org", completed.stderr)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
