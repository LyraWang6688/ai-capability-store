#!/usr/bin/env python3
"""Deterministic offline tests for sync_from_cloud.py — no network, no gh.

Run: python3 automations/github-trending/daily/test_sync_from_cloud.py
Exit: 0 all pass, 1 any failure.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import io
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


class TestUnreadableIsNotAbsent(unittest.TestCase):
    """Absent and unreadable must stay distinguishable.

    2026-10-19: the first sync hit a transient gh failure, reported
    `today_available: false`, and would have made the daily report claim
    "今天云端数据缺失" while `trending/2026-10-19.json` was on the data branch.
    """

    def _summary(self, dest, days, loader):
        argv = ["sync_from_cloud.py", "--dest", dest, "--days", str(days), "--json"]
        buf = io.StringIO()
        with mock.patch.object(sync, "_load_snapshot", side_effect=loader), \
             mock.patch.object(sync.time, "sleep", return_value=None), \
             mock.patch.object(sys, "argv", argv), \
             mock.patch("sys.stdout", buf):
            self.assertEqual(sync.main(), 0)
        return json.loads(buf.getvalue())

    def test_unreadable_day_is_not_reported_as_absent(self):
        def loader(repo, branch, day):
            raise sync.Unreadable("gh timed out")

        with tempfile.TemporaryDirectory() as dest:
            summary = self._summary(dest, 1, loader)
        self.assertIn(DAY0, summary["unreadable"])
        self.assertNotIn(DAY0, summary["absent_in_cloud"],
                         "读不到不等于不存在 —— 这正是 10-19 的假阴性")
        self.assertEqual(summary["today_status"], "unreadable")
        self.assertFalse(summary["today_available"])

    def test_confirmed_404_is_still_absent(self):
        with tempfile.TemporaryDirectory() as dest:
            summary = self._summary(dest, 1, lambda r, b, d: None)
        self.assertEqual(summary["absent_in_cloud"], [DAY0])
        self.assertEqual(summary["unreadable"], {})
        self.assertEqual(summary["today_status"], "absent")

    def test_retry_recovers_a_transient_failure(self):
        calls = []

        def loader(repo, branch, day):
            calls.append(day)
            if len(calls) == 1:
                raise sync.Unreadable("transient")
            return _snapshot()

        with tempfile.TemporaryDirectory() as dest:
            summary = self._summary(dest, 1, loader)
            self.assertEqual(summary["fetched"], [DAY0],
                             "重试成功后应正常落盘，而不是记成 absent")
            self.assertEqual(summary["today_status"], "available")
            self.assertTrue(os.path.exists(os.path.join(dest, f"{DAY0}.json")))

    def test_permanent_failure_after_retry_is_unreadable(self):
        calls = []

        def loader(repo, branch, day):
            calls.append(day)
            raise sync.Unreadable("still broken")

        with tempfile.TemporaryDirectory() as dest:
            summary = self._summary(dest, 1, loader)
        self.assertEqual(len(calls), 2, "应恰好重试一次")
        self.assertEqual(summary["today_status"], "unreadable")


class TestNotFoundDetection(unittest.TestCase):
    def test_detects_404_shapes(self):
        import subprocess
        for stderr in ("gh: Not Found (HTTP 404)", "HTTP 404: Not Found", "no such file"):
            completed = subprocess.CompletedProcess([], 1, stdout="", stderr=stderr)
            self.assertTrue(sync._is_not_found(completed), stderr)

    def test_does_not_mistake_a_failure_for_a_404(self):
        import subprocess
        for stderr in ("gh: authentication required", "rate limit exceeded", "connection reset"):
            completed = subprocess.CompletedProcess([], 1, stdout="", stderr=stderr)
            self.assertFalse(sync._is_not_found(completed), stderr)


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
