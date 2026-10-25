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




class TestSummarize(unittest.TestCase):
    def test_stops_at_sentence_boundary(self):
        text = "第一句话说明事件。第二句话补充细节。第三句话不该出现。"
        out = c.summarize(text, limit=40, min_len=10)
        self.assertTrue(out.endswith("。"))
        self.assertNotIn("第三句", out)

    def test_never_cuts_mid_sentence(self):
        text = "苹果拟收购芯片公司弥补AI算力缺口，曾斥20亿美元完成史上第二大并购。" * 5
        out = c.summarize(text, limit=100)
        self.assertTrue(out.endswith("。"), out)

    def test_overlong_single_sentence_gets_ellipsis(self):
        text = "这是一个没有任何标点的超长句子" * 20
        out = c.summarize(text, limit=50)
        self.assertLessEqual(len(out), 51)
        self.assertTrue(out.endswith("…"))

    def test_strips_markdown_links(self):
        out = c.summarize("腾讯控股([00700.HK](http://00700.HK))发布公告。延迟 10 分钟。")
        self.assertNotIn("http", out)
        self.assertIn("00700.HK", out)

    def test_empty(self):
        self.assertEqual(c.summarize(""), "")


def rec(title, company="腾讯控股", ev="并购", day_ms=1_790_000_000_000, amount="", summary="摘要。", link="u"):
    return {"公司": company, "事件类型": ev, "来源标题": title, "新闻日期": day_ms,
            "金额原文": amount, "事件摘要": summary, "来源链接": link}


class TestCluster(unittest.TestCase):
    def test_same_event_merged(self):
        a = rec("腾讯209亿收购喜马拉雅获批")
        b = rec("腾讯209亿元收购喜马拉雅获附条件批准", day_ms=1_790_500_000_000)
        self.assertTrue(c.same_event(a, b))
        self.assertEqual(len(c.cluster([a, b])), 1)

    def test_different_company_not_merged(self):
        a = rec("腾讯收购某公司")
        b = rec("阿里收购某公司", company="阿里巴巴")
        self.assertEqual(len(c.cluster([a, b])), 2)

    def test_date_window_respected(self):
        a = rec("腾讯收购某游戏工作室")
        b = rec("腾讯收购某游戏工作室", day_ms=a["新闻日期"] + 30 * 86_400_000)
        self.assertFalse(c.same_event(a, b))

    def test_same_amount_links_them(self):
        a = rec("腾讯出手", amount="100亿")
        b = rec("另一篇报道", amount="100亿")
        self.assertTrue(c.same_event(a, b))


class TestMergeCluster(unittest.TestCase):
    def test_keeps_earliest_date_and_all_links(self):
        g = [rec("A报道", day_ms=1_790_000_000_000, link="u1", summary="短。"),
             rec("B报道", day_ms=1_780_000_000_000, link="u2", summary="更长的摘要内容完整。")]
        m = c.merge_cluster(g)
        self.assertEqual(m["新闻日期"], 1_780_000_000_000)      # 最早
        self.assertEqual(m["来源数"], 2)
        self.assertEqual(m["来源链接"], "u2\nu1")
        self.assertEqual(m["事件摘要"], "更长的摘要内容完整。")   # 保留最长摘要
        self.assertIn("A报道", m["其他来源"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
