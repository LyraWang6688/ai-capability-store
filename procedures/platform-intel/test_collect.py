#!/usr/bin/env python3
"""platform-intel 采集阶段的夹具测试（不联网）。

两种测试，各管一件事：

  ① 矩阵自洽 —— 每个抓取点引用的信源必须存在；没有信源的点必须写 blocked 原因。
     矩阵会一直变长（平台 × 层 × 点），靠眼睛保证不了引用都落地。

  ② 报告语义 —— no_source / failed 必须分开；一个点只有在它引用的**全部**信源
     都抓到时才叫 ready。把这条写死，是为了防止哪天报告安静地变得更乐观。

跑法：python3 test_collect.py
"""

import unittest

import collect


DOC = {
    "sources": {
        "good": {"url": "https://example.test/good", "kind": "json"},
        "forbidden": {"url": "https://example.test/403", "kind": "html"},
        "unknown": {"url": None, "kind": "none", "note": "还没找到该看哪儿"},
    },
    "platforms": {
        "demo": {
            "product": [
                {"point": "能抓到", "from": ["good"]},
                {"point": "抓不到", "from": ["forbidden"]},
                {"point": "两个都要", "from": ["good", "forbidden"]},
            ],
            "ecosystem": [
                {"point": "还没有信源", "from": [], "blocked": "公开文档里没有"},
            ],
        }
    },
}


def fake_fetcher(url):
    if url.endswith("/good"):
        return "ok", b'{"k":1}'
    if url.endswith("/403"):
        return "http_403", b""
    raise AssertionError(f"unexpected url: {url}")


class MatrixTest(unittest.TestCase):
    def test_shipped_matrix_is_self_consistent(self):
        """真实的 sources.yaml 必须自洽 —— 这是这条流水线最重要的一条断言。"""
        doc = collect.load_yaml(collect.os.path.join(collect.HERE, "sources.yaml"))
        self.assertEqual(collect.validate_matrix(doc), [])

    def test_dangling_source_is_reported(self):
        broken = {"sources": {}, "platforms": {"p": {"product": [
            {"point": "x", "from": ["nope"]}]}}}
        problems = collect.validate_matrix(broken)
        self.assertTrue(any("不存在的信源" in p for p in problems), problems)

    def test_point_without_source_must_explain_itself(self):
        broken = {"sources": {}, "platforms": {"p": {"product": [
            {"point": "x", "from": []}]}}}
        problems = collect.validate_matrix(broken)
        self.assertTrue(any("blocked" in p for p in problems), problems)


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.report = collect.collect(DOC, fetcher=fake_fetcher)
        self.rows = {r["point"]: r for layer in self.report["coverage"]["demo"].values()
                     for r in layer}

    def test_ok_source_records_hash_and_size(self):
        cell = self.report["sources"]["good"]
        self.assertEqual(cell["status"], "ok")
        self.assertEqual(cell["bytes"], len(b'{"k":1}'))
        self.assertEqual(len(cell["sha256"]), 16)

    def test_no_source_is_not_a_failure(self):
        self.assertEqual(self.report["sources"]["unknown"]["status"], "no_source")
        summary = self.report["summary"]
        self.assertEqual(summary["no_source"], 1)
        self.assertEqual(summary["ok"], 1)
        self.assertEqual(summary["failed"], 1)

    def test_point_is_ready_only_when_all_its_sources_are_ok(self):
        self.assertEqual(self.rows["能抓到"]["state"], "ready")
        self.assertEqual(self.rows["抓不到"]["state"], "source_unavailable")
        self.assertEqual(self.rows["两个都要"]["state"], "source_unavailable")

    def test_point_without_sources_is_blocked_not_ready(self):
        self.assertEqual(self.rows["还没有信源"]["state"], "blocked")
        self.assertEqual(self.report["summary"]["points_blocked"], 1)
        self.assertEqual(self.report["summary"]["points_ready"], 1)

    def test_point_whose_source_has_no_url_is_not_ready(self):
        """信源存在但没有 URL，等于"还没找到该看哪儿"——不能算 ready。"""
        doc = {
            "sources": {"nourl": {"url": None, "kind": "none"}},
            "platforms": {"p": {"product": [{"point": "x", "from": ["nourl"]}]}},
        }
        report = collect.collect(doc, fetcher=fake_fetcher)
        self.assertEqual(report["coverage"]["p"]["product"][0]["state"], "source_unavailable")

    def test_source_is_fetched_once_even_if_many_points_use_it(self):
        calls = []

        def counting(url):
            calls.append(url)
            return fake_fetcher(url)

        collect.collect(DOC, fetcher=counting)
        self.assertEqual(calls.count("https://example.test/good"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
