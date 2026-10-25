#!/usr/bin/env python3
"""investdesk-daily-context 的夹具测试（不联网、不读表）。"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("collect", os.path.join(HERE, "collect.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class TestFormat(unittest.TestCase):
    def test_yi(self):
        self.assertEqual(c.fmt_amount(898666874900), "8,987亿")

    def test_wan(self):
        self.assertEqual(c.fmt_amount(12345), "1万")

    def test_none_and_zero(self):
        self.assertEqual(c.fmt_amount(None), "—")
        self.assertEqual(c.fmt_amount(0), "—")


MARKET_TABLE = {
    "columns": [{"name": n} for n in
                ["中文简称", "最新交易日", "最新成交价", "前收盘价", "涨跌幅", "涨跌", "成交额", "Wind代码"]],
    "rows": [
        ["上证指数", "20261023", "3690.48", "3658.03", "0.89", "32.45", "898666874900", "000001.SH"],
        ["停牌指数", "20261023", "", "", "", "", "", "999999.SH"],
    ],
}


class TestMarket(unittest.TestCase):
    def test_parse_skips_rows_without_prices(self):
        out = c.parse_market(MARKET_TABLE)
        self.assertEqual(len(out), 1)          # 停牌/空价格的行被跳过
        self.assertEqual(out[0]["name"], "上证指数")
        self.assertAlmostEqual(out[0]["pct"], 0.89)
        self.assertEqual(out[0]["turnover"], 898666874900.0)

    def test_empty_table(self):
        self.assertEqual(c.parse_market({}), [])


HOLDINGS = [
    {"名称": "紫金矿业", "代码": "601899", "持有数量": 1744, "最新市值": 23032},
    {"名称": "已清仓", "代码": "000001", "持有数量": 0, "最新市值": 0},
    {"名称": "欣旺达", "代码": "300207", "持有数量": "100", "最新市值": "11232"},
    {"名称": "无数量", "代码": "600000", "持有数量": None, "最新市值": 500},
]


class TestHoldings(unittest.TestCase):
    def test_only_active_sorted_by_mv(self):
        out = c.pick_active(HOLDINGS, 10)
        self.assertEqual([h["名称"] for h in out], ["紫金矿业", "欣旺达"])

    def test_top_n_limit(self):
        self.assertEqual(len(c.pick_active(HOLDINGS, 1)), 1)

    def test_query_contains_name(self):
        self.assertIn("紫金矿业", c.news_query("紫金矿业"))


class TestNewsFilter(unittest.TestCase):
    def test_event_news_kept(self):
        self.assertTrue(c.is_useful_news({"title": "紫金矿业收购赤峰黄金交易落地",
                                          "content": "公司公告称"}))
        self.assertTrue(c.is_useful_news({"title": "某公司三季报业绩增长", "content": ""}))

    def test_research_and_analysis_dropped(self):
        for title in ["某券商研报：维持买入评级", "XX公司深度全面分析", "如何看待这家公司"]:
            self.assertFalse(c.is_useful_news({"title": title, "content": ""}), title)

    def test_irrelevant_dropped(self):
        self.assertFalse(c.is_useful_news({"title": "今天的天气", "content": ""}))
        # 事件词只在正文深处、标题无关 → 也丢（只看正文前 120 字）
        self.assertFalse(c.is_useful_news({"title": "公司公告", "content": "x" * 200 + "收购"}))


class TestPayloadParse(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(c._parse_payload('{"a":1}'), {"a": 1})

    def test_sse(self):
        self.assertEqual(c._parse_payload('event: message\ndata: {"b":2}\n'), {"b": 2})

    def test_unparseable_raises(self):
        with self.assertRaises(RuntimeError):
            c._parse_payload("not a payload")


if __name__ == "__main__":
    unittest.main(verbosity=2)
