#!/usr/bin/env python3
"""Deterministic offline tests for aggregate.py — no network, no snapshots on disk.

Run: python3 automations/github-trending-weekly/test_aggregate.py
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

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("aggregate", os.path.join(HERE, "aggregate.py"))
aggregate = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(aggregate)

TODAY = dt.date.today()


def _day(offset: int) -> str:
    return (TODAY - dt.timedelta(days=offset)).isoformat()


def _snapshot(stars_by_repo, topics=None, gains=None):
    """Build one daily snapshot document in the shape scan.py writes."""
    topics = topics or {}
    gains = gains or {}
    candidates = [
        {
            "repo": repo,
            "stars": stars,
            "trend_gain": gains.get(repo, 0),
            "topics": topics.get(repo, []),
            "desc": "",
        }
        for repo, stars in stars_by_repo.items()
    ]
    topic_frequency = {}
    for repo in stars_by_repo:
        for topic in topics.get(repo, []):
            topic_frequency.setdefault(topic, 0)
            topic_frequency[topic] += 1
    return {
        "candidates": candidates,
        "topic_frequency": [{"topic": t, "repos": n} for t, n in topic_frequency.items()],
    }


def _write(directory, day, document):
    with open(os.path.join(directory, f"{day}.json"), "w", encoding="utf-8") as handle:
        json.dump(document, handle)


class TestLoadSnapshots(unittest.TestCase):
    def test_reports_missing_days_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            _write(directory, _day(0), _snapshot({"a/b": 10}))
            loaded, missing = aggregate.load_snapshots(directory, days=3)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(len(missing), 2)
        self.assertIn(_day(0), loaded)

    def test_ignores_weekly_and_corrupt_files(self):
        with tempfile.TemporaryDirectory() as directory:
            _write(directory, _day(0), _snapshot({"a/b": 10}))
            _write(directory, f"weekly-{_day(0)}", {"junk": True})
            with open(os.path.join(directory, f"{_day(1)}.json"), "w", encoding="utf-8") as handle:
                handle.write("{not json")
            loaded, _ = aggregate.load_snapshots(directory, days=3)
        self.assertEqual(list(loaded), [_day(0)])


class TestHonestyGate(unittest.TestCase):
    def test_one_day_is_not_trustworthy(self):
        snapshots = {_day(0): _snapshot({"a/b": 10}, {"a/b": ["mcp"]})}
        result = aggregate.aggregate(snapshots, days=7)
        self.assertFalse(result["trustworthy"])
        self.assertEqual(result["days_with_data"], 1)
        self.assertIn("insufficient data", result["note"])
        self.assertEqual(result["topics_persistent"], [])

    def test_three_days_crosses_the_threshold(self):
        snapshots = {
            _day(offset): _snapshot({"a/b": 10 + offset}, {"a/b": ["mcp"]})
            for offset in range(3)
        }
        result = aggregate.aggregate(snapshots, days=7)
        self.assertTrue(result["trustworthy"])
        self.assertIn("gaps", result["note"])  # 4 of 7 days missing


class TestTrendMath(unittest.TestCase):
    def test_star_delta_uses_first_and_last_observation(self):
        # Rising across the window: delta must be positive and equal last-first.
        snapshots = {
            _day(4): _snapshot({"a/b": 100}),
            _day(2): _snapshot({"a/b": 150}),
            _day(0): _snapshot({"a/b": 400}),
        }
        result = aggregate.aggregate(snapshots, days=7)
        sustained = {r["repo"]: r for r in result["repos_sustained"]}
        self.assertEqual(sustained["a/b"]["star_delta"], 300)
        self.assertEqual(sustained["a/b"]["stars_now"], 400)
        self.assertEqual(sustained["a/b"]["days_seen"], 3)

    def test_one_day_wonder_flagged_separately_from_sustained(self):
        # `spike/only` appears once with a huge gain; `steady/one` appears 3x.
        snapshots = {_day(offset): _snapshot({"steady/one": 1000}) for offset in range(3)}
        snapshots[_day(0)]["candidates"].append(
            {"repo": "spike/only", "stars": 5000, "trend_gain": 2301, "topics": [], "desc": ""}
        )
        result = aggregate.aggregate(snapshots, days=7)
        self.assertEqual([r["repo"] for r in result["repos_one_day_wonders"]], ["spike/only"])
        self.assertIn("steady/one", [r["repo"] for r in result["repos_sustained"]])
        self.assertNotIn("spike/only", [r["repo"] for r in result["repos_sustained"]])

    def test_declining_repo_excluded_from_climbing(self):
        snapshots = {_day(2): _snapshot({"down/x": 900}), _day(0): _snapshot({"down/x": 800})}
        result = aggregate.aggregate(snapshots, days=7)
        self.assertNotIn("down/x", [r["repo"] for r in result["repos_climbing_by_stars"]])


class TestTopicVerdicts(unittest.TestCase):
    def test_persistent_vs_emerging(self):
        snapshots = {}
        for offset in range(3):
            snapshots[_day(offset)] = _snapshot(
                {"a/b": 10}, {"a/b": ["mcp"] if offset else ["mcp"]}
            )
        # `agent-ide` only in today's snapshot.
        snapshots[_day(0)]["topic_frequency"].append({"topic": "agent-ide", "repos": 2})
        result = aggregate.aggregate(snapshots, days=7)
        self.assertIn("mcp", [t["topic"] for t in result["topics_persistent"]])
        emerging = [t["topic"] for t in result["topics_emerging"]]
        self.assertIn("agent-ide", emerging)
        self.assertNotIn("mcp", emerging)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
