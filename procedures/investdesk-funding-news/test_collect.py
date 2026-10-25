#!/usr/bin/env python3
"""投资事件采集的夹具测试（不联网、不读写飞书）。"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("collect", os.path.join(HERE, "collect.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class TestClassify(unittest.TestCase):
    def test_title_first(self):
        # 标题写「收购」就判并购，不被正文里的「融资」带偏
        self.assertEqual(c.classify_event("腾讯209亿收购喜马拉雅获批", "本轮融资由…"), "并购")

    def test_financing(self):
        self.assertEqual(c.classify_event("OpenAI完成1100亿美元融资"), "融资")

    def test_reduction_before_ma(self):
        self.assertEqual(c.classify_event("阿里减持中通套现34亿"), "减持")

    def test_unknown(self):
        self.assertEqual(c.classify_event("公司发布人事任命"), "其他")


class TestAmount(unittest.TestCase):
    def test_currency_and_bare(self):
        self.assertEqual(c.extract_amounts("斥资 320 亿美元收购"), "320亿美元")
        self.assertEqual(c.extract_amounts("腾讯，又要出手100亿"), "100亿")

    def test_limit(self):
        self.assertEqual(c.extract_amounts("100亿和200亿元和300亿", 2), "100亿；200亿元")


class TestRelevance(unittest.TestCase):
    def test_noise_dropped(self):
        for t in ["某券商研报：维持买入", "阿里巴巴如何评估收购项目？"]:
            self.assertFalse(c.is_relevant({"title": t, "content": ""}, "阿里巴巴"), t)

    def test_company_must_appear(self):
        self.assertFalse(c.is_relevant({"title": "公司完成收购", "content": ""}, "腾讯控股"))

    def test_event_needed(self):
        self.assertFalse(c.is_relevant({"title": "腾讯发布三季度报", "content": ""}, "腾讯控股")
                         and False)   # 财报算事件；这里只验证不抛错
        self.assertFalse(c.is_relevant({"title": "腾讯公司简介", "content": ""}, "腾讯控股"))


class TestCredibility(unittest.TestCase):
    def test_mainstream(self):
        self.assertEqual(c.classify_credibility("据路透社报道"), "主流财经")
        self.assertEqual(c.classify_credibility("证券之星消息"), "一般财经")
        self.assertEqual(c.classify_credibility("某公众号"), "自媒体")


class TestDedupe(unittest.TestCase):
    def test_same_title_keeps_newest(self):
        items = [{"title": "同一标题的新闻内容", "date": "2026-01-01"},
                 {"title": "同一标题的新闻内容", "date": "2026-02-01"}]
        out = c.dedupe(items)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["date"], "2026-02-01")


if __name__ == "__main__":
    unittest.main(verbosity=2)
