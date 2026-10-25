#!/usr/bin/env python3
"""platform-intel 采集阶段的夹具测试（不联网）。

为什么要有它：这条流水线的价值全在「同样的输入，必须给出同样的结果」。
一旦哪天有人把 no_source 合并进 failed、或者把抓取失败当成功，
报告会安静地变得更乐观 —— 而报告是拿来决定"在哪个平台做插件"的。

跑法：python3 test_collect.py
"""

import unittest

import collect


SOURCES = {
    "platforms": {
        "demo": {
            "product": [
                {"id": "releases", "url": "https://example.test/releases"},
                {"id": "unknown-page", "url": None, "note": "还没找到该看哪儿"},
            ],
            "api": [
                {"id": "portal", "url": "https://example.test/403"},
            ],
            "ecosystem": [
                {"id": "pricing", "url": "https://example.test/down"},
            ],
        }
    }
}


def fake_fetcher(url):
    if url.endswith("/releases"):
        return "ok", b'[{"tag_name":"v1.2.3"}]'
    if url.endswith("/403"):
        return "http_403", b""
    if url.endswith("/down"):
        return "unreachable", b""
    raise AssertionError(f"unexpected url: {url}")


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.report = collect.collect(SOURCES, fetcher=fake_fetcher)
        self.cells = {c["id"]: c for layer in self.report["platforms"]["demo"].values()
                      for c in layer}

    def test_ok_cell_records_hash_and_size(self):
        cell = self.cells["releases"]
        self.assertEqual(cell["status"], "ok")
        self.assertEqual(cell["bytes"], len(b'[{"tag_name":"v1.2.3"}]'))
        self.assertEqual(len(cell["sha256"]), 16)

    def test_no_source_is_not_a_failure(self):
        """no_source 和 failed 必须分开：一个是不知道去哪看，一个是知道但抓不到。"""
        self.assertEqual(self.cells["unknown-page"]["status"], "no_source")
        summary = self.report["summary"]
        self.assertEqual(summary["no_source"], 1)
        self.assertEqual(summary["ok"], 1)
        self.assertEqual(summary["failed"], 2)

    def test_http_error_carries_its_code(self):
        self.assertEqual(self.cells["portal"]["status"], "http_403")

    def test_unreachable_is_recorded_not_raised(self):
        self.assertEqual(self.cells["pricing"]["status"], "unreachable")

    def test_report_is_deterministic_for_same_input(self):
        again = collect.collect(SOURCES, fetcher=fake_fetcher)
        strip = lambda r: {p: {l: [{k: v for k, v in c.items() if k != "generated_at"}
                                 for c in cells] for l, cells in layers.items()}
                           for p, layers in r["platforms"].items()}
        self.assertEqual(strip(self.report), strip(again))

    def test_only_filters_to_one_platform(self):
        report = collect.collect(SOURCES, fetcher=fake_fetcher, only="nope")
        self.assertEqual(report["platforms"], {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
