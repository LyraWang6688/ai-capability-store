#!/usr/bin/env python3
"""Deterministic offline tests for sync_from_cloud.py — no network, no gh.

Run: python3 automations/github-trending-daily/test_sync_from_cloud.py
Exit: 0 all pass, 1 any failure.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("sync", os.path.join(HERE, "sync_from_cloud.py"))
sync = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(sync)

TODAY = dt.date.today()
DAY0 = TODAY.isoformat()
DAY1 = (TODAY - dt.timedelta(days=1)).isoformat()


def _snapshot(repo="a/b", stars=10):
    return {"automation": "github-trending-daily",
            "candidates": [{"repo": repo, "stars": stars}],
            "topic_frequency": []}


def _run(dest, days, loader):
    argv = ["sync_from_cloud.py", "--dest", dest, "--days", str(days), "--json"]
    with mock.patch.object(sync, "_load_snapshot", side_effect=loader), \
         mock.patch.object(sys, "argv", argv), \
         mock.patch("sys.stdout", new_callable=lambda: open(os.devnull, "w")):
        return sync.main()


class TestNeverOverwrites(unittest.TestCase):
    def test_existing_day_is_not_refetched(self):
        with tempfile.TemporaryDirectory() as dest:
            existing = os.path.join(dest, f"{DAY0}.json")
            with open(existing, "w", encoding="utf-8") as fh:
                json.dump({"candidates": [{"repo": "local/only"}]}, fh)
            calls = []

            def loader(repo, branch, day):
                calls.append(day)
                return _snapshot()

            _run(dest, 2, loader)
            self.assertNotIn(DAY0, calls, "已存在的快照不应再拉取，否则会覆盖本地产出")
            with open(existing, encoding="utf-8") as fh:
                self.assertEqual(json.load(fh)["candidates"][0]["repo"], "local/only")


class TestMissingDays(unittest.TestCase):
    def test_only_absent_days_are_fetched(self):
        with tempfile.TemporaryDirectory() as dest:
            calls = []
            _run(dest, 2, lambda r, b, d: calls.append(d) or _snapshot())
            self.assertEqual(sorted(calls), sorted([DAY0, DAY1]))
            for day in (DAY0, DAY1):
                self.assertTrue(os.path.exists(os.path.join(dest, f"{day}.json")))

    def test_absent_in_cloud_is_skipped_not_written(self):
        with tempfile.TemporaryDirectory() as dest:
            _run(dest, 2, lambda r, b, d: None)
            self.assertEqual(os.listdir(dest), [], "云端没有的天不应留下空文件")


class TestNonFatal(unittest.TestCase):
    def test_loader_returning_none_never_raises(self):
        with tempfile.TemporaryDirectory() as dest:
            self.assertEqual(_run(dest, 3, lambda r, b, d: None), 0)

    def test_unexpected_exception_exits_1_but_is_flagged_non_fatal(self):
        # The module's __main__ guard converts any exception into exit 1 with a
        # warning; main() itself must not swallow programmer errors silently.
        with tempfile.TemporaryDirectory() as dest:
            def boom(repo, branch, day):
                raise RuntimeError("network gone")

            with self.assertRaises(RuntimeError):
                _run(dest, 2, boom)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
