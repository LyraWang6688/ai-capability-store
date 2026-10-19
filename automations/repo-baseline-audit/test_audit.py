#!/usr/bin/env python3
"""离线测试：只验证聚合与渲染，不联网、不写表。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit_baseline as ab
import run_audit as ra


class AggregationTest(unittest.TestCase):
    def test_failing_text_lists_only_fail(self):
        res = {iid: ab.PASS for iid, _g, _n, _f in ab.ITEMS}
        res["A2"] = ab.FAIL
        res["B3"] = ab.FAIL
        res["A1"] = ab.UNKNOWN
        text = ra.failing_text(res)
        self.assertIn("A2", text)
        self.assertIn("B3", text)
        self.assertNotIn("A1", text)

    def test_row_counts(self):
        # audit() 需要网络，这里只验证计数逻辑的输入形状
        res = {iid: ab.PASS for iid, _g, _n, _f in ab.ITEMS}
        res["A1"] = ab.FAIL
        res["A2"] = ab.UNKNOWN
        counts = {ab.PASS: 0, ab.FAIL: 0, ab.UNKNOWN: 0}
        for iid, _g, _n, _f in ab.ITEMS:
            counts[res.get(iid, ab.UNKNOWN)] += 1
        self.assertEqual(sum(counts.values()), len(ab.ITEMS))
        self.assertEqual(counts[ab.FAIL], 1)
        self.assertEqual(counts[ab.UNKNOWN], 1)

    def test_dry_run_writes_nothing(self):
        rows = [{"repo": "a/b", "pass": 1, "fail": 2, "unknown": 3, "failing": "A2"}]
        self.assertEqual(ra.write_rows({}, rows, True), 0)


if __name__ == "__main__":
    unittest.main()
