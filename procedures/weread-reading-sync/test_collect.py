#!/usr/bin/env python3
"""collect.py 的确定性分支测试（不联网、不写库）。"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("collect", os.path.join(HERE, "collect.py"))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class TestFinished(unittest.TestCase):
    def test_only_100_with_finish_time_counts(self):
        self.assertTrue(c.is_finished({"progress": 100, "finishTime": 1607529600}))

    def test_100_without_finish_time_is_finished(self):
        # 2026-10-26 起不再要求 finishTime：跳过后记的书不会触发"读完"事件
        self.assertTrue(c.is_finished({"progress": 100, "finishTime": None}))

    def test_98_with_finish_time_is_finished(self):
        # 2026-10-26 起阈值放宽到 98：真实案例《21天说服力养成》98% + finishTime → 读完
        self.assertTrue(c.is_finished({"progress": 98, "finishTime": 1607529600}))

    def test_99_with_finish_time_is_finished(self):
        self.assertTrue(c.is_finished({"progress": 99, "finishTime": 1607529600}))

    def test_97_with_finish_time_is_not_finished(self):
        self.assertFalse(c.is_finished({"progress": 97, "finishTime": 1607529600}))

    def test_98_without_finish_time_is_finished(self):
        # 用户跳过后记/致谢，进度停在 98 且没有 finishTime —— 这就是要覆盖的真实场景
        self.assertTrue(c.is_finished({"progress": 98, "finishTime": None}))

    def test_none_progress(self):
        self.assertFalse(c.is_finished(None))


class TestReading(unittest.TestCase):
    NOW = 1_700_000_000

    def test_inside_window(self):
        self.assertTrue(c.is_reading({"progress": 50, "lastReadTime": self.NOW - 86400}, self.NOW, 30))

    def test_outside_window(self):
        self.assertFalse(c.is_reading({"progress": 50, "lastReadTime": self.NOW - 40 * 86400}, self.NOW, 30))

    def test_finished_never_reading(self):
        self.assertFalse(c.is_reading({"progress": 100, "finishTime": 1, "lastReadTime": self.NOW}, self.NOW, 30))

    def test_zero_progress_still_counts_if_recent(self):
        # 真实行为：最近打开过但一页没读，进度 0
        self.assertTrue(c.is_reading({"progress": 0, "lastReadTime": self.NOW - 3600}, self.NOW, 30))

    def test_missing_timestamp(self):
        self.assertFalse(c.is_reading({"progress": 10}, self.NOW, 30))


class TestFinishedTime(unittest.TestCase):
    def test_prefers_finish_time(self):
        self.assertEqual(c.finished_time_of({"finishTime": 111, "lastReadTime": 222}), 111)

    def test_falls_back_to_last_read(self):
        self.assertEqual(c.finished_time_of({"finishTime": None, "lastReadTime": 222}), 222)

    def test_none(self):
        self.assertIsNone(c.finished_time_of({}))


class TestDates(unittest.TestCase):
    def test_round_trip(self):
        for iso in ("2020-12-10", "2024-08-11", "2026-10-23"):
            self.assertEqual(c.fmt_date(c.ms_of_date(iso) // 1000), iso)

    def test_none(self):
        self.assertIsNone(c.fmt_date(None))


class TestRecords(unittest.TestCase):
    INFO = {"bookId": "123", "title": "书名", "author": "作者", "category": "文学-散文杂著",
            "intro": "x" * 2000, "readerLink": "https://weread.qq.com/web/reader/abc"}

    def test_finished_record(self):
        rec = c.build_finished_record(self.INFO, c.ms_of_date("2024-08-11") // 1000)
        self.assertEqual(rec["微信读书ID"], "123")
        self.assertEqual(rec["分类"], ["文学-散文杂著"])
        self.assertEqual(len(rec["简介"]), 1500)          # 截断
        self.assertIsInstance(rec["读完时间"], int)       # 毫秒时间戳

    def test_finished_record_carries_reader_link(self):
        rec = c.build_finished_record(self.INFO, 1_700_000_000)
        self.assertEqual(rec["阅读链接"], "https://weread.qq.com/web/reader/abc")

    def test_reading_record(self):
        rec = c.build_reading_record(self.INFO, {"progress": 36, "lastReadTime": 1_700_000_000})
        self.assertEqual(rec["阅读进度"], 36)
        self.assertEqual(rec["最近阅读时间"], 1_700_000_000)
        self.assertEqual(len(rec["简介"]), 1200)

    def test_record_without_category_omits_selector(self):
        info = dict(self.INFO, category=None)
        self.assertIsNone(c.build_finished_record(info, 1) ["分类"])


class TestPlan(unittest.TestCase):
    def test_create_when_absent(self):
        p = c.plan({}, [{"微信读书ID": "a", "中文书名": "A"}])
        self.assertEqual(len(p["create"]), 1)
        self.assertEqual(p["update"], {})

    def test_skip_when_identical(self):
        existing = {"a": {"record_id": "rec1", "微信读书ID": "a", "中文书名": "A"}}
        p = c.plan(existing, [{"微信读书ID": "a", "中文书名": "A"}])
        self.assertEqual(p["skip"], ["a"])
        self.assertEqual(p["update"], {})

    def test_update_only_changed_field(self):
        existing = {"a": {"record_id": "rec1", "微信读书ID": "a",
                          "中文书名": "A", "阅读进度": 10}}
        p = c.plan(existing, [{"微信读书ID": "a", "中文书名": "A", "阅读进度": 36}])
        self.assertEqual(p["update"], {"rec1": {"阅读进度": 36}})

    def test_category_list_vs_string_is_equal(self):
        existing = {"a": {"record_id": "r", "微信读书ID": "a", "分类": "文学-散文杂著"}}
        p = c.plan(existing, [{"微信读书ID": "a", "分类": ["文学-散文杂著"]}])
        self.assertEqual(p["skip"], ["a"])

    def test_recent_time_iso_vs_epoch_is_equal(self):
        existing = {"a": {"record_id": "r", "微信读书ID": "a",
                          "最近阅读时间": "2026-10-26T00:00:00.000+08:00"}}
        ts = c.ms_of_date("2026-10-26") // 1000
        p = c.plan(existing, [{"微信读书ID": "a", "最近阅读时间": ts}])
        self.assertEqual(p["skip"], ["a"])

    def test_idempotent_second_run(self):
        desired = [{"微信读书ID": "a", "中文书名": "A", "阅读进度": 36}]
        first = c.plan({}, desired)
        existing = {"a": dict(desired[0], record_id="rec1")}
        second = c.plan(existing, desired)
        self.assertEqual(len(first["create"]), 1)
        self.assertEqual(second["create"], [])
        self.assertEqual(second["update"], {})


class TestCacheFreshness(unittest.TestCase):
    NOW = 1_700_000_000

    def test_no_entry_is_stale(self):
        self.assertTrue(c.cache_is_stale(None, None, self.NOW))

    def test_old_format_is_stale(self):
        # 旧缓存没有 cachedAt → 重查一次自愈
        self.assertTrue(c.cache_is_stale({"progress": 50}, None, self.NOW))

    def test_fresh_without_change(self):
        e = {"progress": 50, "cachedAt": self.NOW - 3600, "shelfSeen": 111}
        self.assertFalse(c.cache_is_stale(e, 111, self.NOW))

    def test_shelf_read_time_changed_refetches(self):
        # 关键：书架显示又读了（readUpdateTime 变了）→ 必须重查，否则永远发现不了新读完
        e = {"progress": 50, "cachedAt": self.NOW - 60, "shelfSeen": 111}
        self.assertTrue(c.cache_is_stale(e, 222, self.NOW))

    def test_ttl_expiry(self):
        e = {"progress": 50, "cachedAt": self.NOW - 8 * 86400, "shelfSeen": 111}
        self.assertTrue(c.cache_is_stale(e, 111, self.NOW, ttl_hours=168))

    def test_no_shelf_signal_only_ttl(self):
        e = {"progress": 50, "cachedAt": self.NOW - 3600, "shelfSeen": None}
        self.assertFalse(c.cache_is_stale(e, None, self.NOW))


class TestInfoCacheUpgrade(unittest.TestCase):
    NOW = 1_700_000_000

    def test_cache_without_reader_link_is_stale(self):
        # 旧缓存（加 readerLink 之前）要重查一次，否则阅读链接永远补不上
        entry = {"cachedAt": self.NOW, "info": {"title": "x"}}
        self.assertTrue(c.info_is_stale(entry, self.NOW))

    def test_cache_with_reader_link_is_fresh(self):
        entry = {"cachedAt": self.NOW, "info": {"readerLink": None}}
        self.assertFalse(c.info_is_stale(entry, self.NOW))


class TestInfoCache(unittest.TestCase):
    NOW = 1_700_000_000

    def test_no_entry_is_stale(self):
        self.assertTrue(c.info_is_stale(None, self.NOW))

    def test_fresh(self):
        self.assertFalse(c.info_is_stale(
            {"cachedAt": self.NOW - 86400, "info": {"title": "x", "readerLink": "u"}}, self.NOW))

    def test_ttl_expiry_30d(self):
        self.assertTrue(c.info_is_stale({"cachedAt": self.NOW - 31 * 86400, "info": {}}, self.NOW))

    def test_entry_without_info_is_stale(self):
        self.assertTrue(c.info_is_stale({"cachedAt": self.NOW}, self.NOW))


class TestOptions(unittest.TestCase):
    def test_missing_options(self):
        self.assertEqual(c.missing_options({"文学-散文杂著"}, ["文学-散文杂著", "漫画-治愈漫画"]),
                         ["漫画-治愈漫画"])

    def test_missing_options_dedup_and_skip_empty(self):
        self.assertEqual(c.missing_options(set(), ["A", "A", "", None]), ["A"])

    def test_missing_options_all_present(self):
        self.assertEqual(c.missing_options({"A", "B"}, ["A", "B"]), [])


class TestMigration(unittest.TestCase):
    def test_finished_book_leaves_reading_table(self):
        recs = {"a": {"record_id": "rec1"}, "b": {"record_id": "rec2"}}
        prog = {"a": {"progress": 100, "finishTime": 111},
                "b": {"progress": 40, "lastReadTime": 222}}
        out = c.books_to_leave_reading(recs, prog.get)
        self.assertEqual([r["record_id"] for r in out], ["rec1"])

    def test_idle_unfinished_book_stays(self):
        # 读了一半放着（超出窗口但未读完）不该被迁出
        recs = {"b": {"record_id": "rec2"}}
        prog = {"b": {"progress": 40, "lastReadTime": 1}}
        self.assertEqual(c.books_to_leave_reading(recs, prog.get), [])

    def test_progress_100_without_finish_time_leaves(self):
        # 口径变更后，这类书也算读完，应从在读表迁出
        recs = {"a": {"record_id": "rec1"}}
        prog = {"a": {"progress": 100, "finishTime": None}}
        out = c.books_to_leave_reading(recs, prog.get)
        self.assertEqual([r["record_id"] for r in out], ["rec1"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
