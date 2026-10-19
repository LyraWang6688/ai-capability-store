#!/usr/bin/env python3
"""Offline tests for check_sources.py — the collection health gate.

The gate exists because a dead source on 2026-10-19 produced a green workflow
run. These tests pin the three verdicts apart:

    0  healthy      → nothing to say
    1  degraded     → commit anyway, but say it loudly
    2  unusable     → the snapshot must not be trusted
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(HERE, "check_sources.py")


def _doc(candidates=30, warnings=None, topics=None):
    return {
        "automation": "github-trending-daily",
        "candidates": [{"repo": f"o/r{i}", "source": "trending-daily"} for i in range(candidates)],
        "topic_frequency": topics if topics is not None else [{"topic": "mcp", "repos": 5}],
        "warnings": warnings or [],
    }


def _run(document, extra_args=()):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snap.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(document, fh)
        return subprocess.run(
            [sys.executable, CHECK, path, *extra_args],
            capture_output=True, text=True,
        )


class TestVerdicts(unittest.TestCase):
    def test_healthy_snapshot_exits_zero(self):
        completed = _run(_doc())
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertNotIn("::warning", completed.stdout)

    def test_warnings_degrade_but_stay_committable(self):
        completed = _run(_doc(warnings=["trending-weekly: TypeError: boom"]))
        self.assertEqual(completed.returncode, 1,
                         "降级应当可见，但不应阻止提交")
        self.assertIn("::warning", completed.stdout)
        self.assertIn("trending-weekly", completed.stdout)

    def test_too_few_candidates_is_an_error_not_a_warning(self):
        completed = _run(_doc(candidates=3))
        self.assertEqual(completed.returncode, 2,
                         "候选数塌到这个程度不是「降级」，是「坏了」")
        self.assertIn("::error", completed.stdout)

    def test_missing_snapshot_exits_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.run(
                [sys.executable, CHECK, os.path.join(tmp, "nope.json")],
                capture_output=True, text=True,
            )
        self.assertEqual(completed.returncode, 2)

    def test_unparseable_snapshot_exits_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            completed = subprocess.run([sys.executable, CHECK, path],
                                       capture_output=True, text=True)
        self.assertEqual(completed.returncode, 2)

    def test_empty_topic_frequency_is_a_warning(self):
        completed = _run(_doc(topics=[]))
        self.assertEqual(completed.returncode, 1)
        self.assertIn("topic_frequency", completed.stdout)


class TestStepSummary(unittest.TestCase):
    def test_summary_is_appended_for_the_run_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = os.path.join(tmp, "summary.md")
            with open(summary, "w", encoding="utf-8") as fh:
                fh.write("")
            completed = _run(_doc(warnings=["a source died"]),
                             extra_args=("--summary", summary))
            self.assertEqual(completed.returncode, 1)
            body = open(summary, encoding="utf-8").read()
        self.assertIn("Collection health", body)
        self.assertIn("a source died", body)
        self.assertIn("candidates | 30", body)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
