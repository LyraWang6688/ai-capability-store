#!/usr/bin/env python3
"""Deterministic offline tests for scan.py — no network, no gh.

Run: python3 automations/github-trending/daily/test_scan.py
Exit: 0 all pass, 1 any failure.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from unittest.mock import patch
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("scan", os.path.join(HERE, "scan.py"))
scan = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(scan)

# Two articles in the shape GitHub's trending page currently emits.
TRENDING_FIXTURE = """
<article>
  <h2 class="h3 lh-condensed"><a href="/debpalash/VoiceStudio">debpalash / VoiceStudio</a></h2>
  <p class="col-9 color-fg-muted my-1 pr-4">Local voice cloning &amp; dubbing.</p>
  <a href="/debpalash/VoiceStudio/stargazers"><svg></svg> 72,054</a>
  <span class="d-inline-block float-sm-right">2,301 stars today</span>
  <span itemprop="programmingLanguage">Python</span>
</article>
<article>
  <h2 class="h3 lh-condensed"><a href="/tailscale/tailscale">tailscale / tailscale</a></h2>
  <p class="col-9 color-fg-muted my-1 pr-4">Mesh VPN.</p>
  <a href="/tailscale/tailscale/stargazers"><svg></svg> 30,000</a>
  <span class="d-inline-block float-sm-right">12 stars today</span>
  <span itemprop="programmingLanguage">Go</span>
</article>
<article>
  <h2 class="h3 lh-condensed"><a href="/not-a-repo">broken entry</a></h2>
</article>
"""


class TestHelpers(unittest.TestCase):
    def test_clean_strips_tags_and_unescapes(self):
        self.assertEqual(scan._clean("  <b>a &amp; b</b>\n c "), "a & b c")

    def test_to_int_handles_thousands_separator_and_junk(self):
        self.assertEqual(scan._to_int("1,234"), 1234)
        self.assertEqual(scan._to_int(" abc"), 0)
        self.assertEqual(scan._to_int(None), 0)


class TestParseTrending(unittest.TestCase):
    def _parse(self, payload=TRENDING_FIXTURE):
        with mock.patch.object(scan, "_fetch", return_value=payload):
            return scan.parse_trending("daily")

    def test_extracts_repo_stars_gain_language(self):
        rows = self._parse()
        first = rows[0]
        self.assertEqual(first["repo"], "debpalash/VoiceStudio")
        self.assertEqual(first["stars"], 72054)
        self.assertEqual(first["trend_gain"], 2301)
        self.assertEqual(first["language"], "Python")
        self.assertEqual(first["source"], "trending-daily")

    def test_skips_entries_without_a_valid_owner_repo_pair(self):
        repos = [row["repo"] for row in self._parse()]
        self.assertNotIn("not-a-repo", repos)

    def test_missing_optional_fields_degrade_to_none(self):
        # A repo with no stargazers link and no "stars today" must not raise.
        payload = '<article><h2><a href="/a/b">a / b</a></h2></article>'
        rows = self._parse(payload)
        self.assertEqual(rows[0]["stars"], 0)
        self.assertIsNone(rows[0]["trend_gain"],
                          "an unmeasured gain is None, never 0 — 0 means 'measured, no growth'")
        self.assertEqual(rows[0]["language"], "")


class TestFiltering(unittest.TestCase):
    def _filter(self, merged):
        """Reproduce main()'s filtering without touching the network."""
        excluded_noise, candidates = [], []
        for repo, item in merged.items():
            blob = f"{repo} {item['desc']}".lower()
            if any(m in blob for m in scan.NOISE_MARKERS) and item["trend_gain"] < 300:
                excluded_noise.append(repo)
                continue
            candidates.append(item)
        return excluded_noise, candidates

    def test_noise_below_threshold_is_excluded(self):
        merged = {"someone/ai-job-search": {"repo": "someone/ai-job-search", "desc": "", "trend_gain": 10}}
        noise, candidates = self._filter(merged)
        self.assertEqual(noise, ["someone/ai-job-search"])
        self.assertEqual(candidates, [])

    def test_noise_with_big_gain_survives(self):
        merged = {"someone/ai-job-search": {"repo": "someone/ai-job-search", "desc": "", "trend_gain": 900}}
        noise, candidates = self._filter(merged)
        self.assertEqual(noise, [])
        self.assertEqual(len(candidates), 1)


class TestMergeAcrossSources(unittest.TestCase):
    """The merge path itself must survive a None trend_gain.

    TestTrendGainTriState covers _max_gain() in isolation. That is not enough:
    _max_gain can be perfectly correct while collect() still calls max(), which
    is exactly the regression that killed the weekly source on 2026-10-19
    (warnings: "trending-weekly: TypeError: '>' not supported between
    instances of 'NoneType' and 'int'"). This test drives collect() end to end
    with the network stubbed out.
    """

    def test_merge_tolerates_a_none_from_one_source(self):
        daily = [{"repo": "owner/a", "stars": 100, "trend_gain": 500,
                  "language": "", "desc": "", "topics": [], "source": "trending-daily"}]
        weekly = [{"repo": "owner/a", "stars": 90, "trend_gain": None,
                   "language": "", "desc": "", "topics": [], "source": "trending-weekly"}]

        def fake_parse(period):
            return daily if period == "daily" else weekly

        warnings: list[str] = []
        with patch.object(scan, "parse_trending", side_effect=fake_parse), \
             patch.object(scan, "search_new_repos", return_value=[]):
            merged, _ = scan.collect(warnings)

        # collect() also warns when search_new_repos() is empty; what matters
        # here is that the merge did not raise.
        self.assertFalse([w for w in warnings if "TypeError" in w],
                         f"merging raised: {warnings}")
        self.assertEqual(merged["owner/a"]["trend_gain"], 500,
                         "the measured value must win over the unknown one")
        self.assertEqual(merged["owner/a"]["source"], "trending-daily+weekly")

    def test_merge_keeps_measured_zero_over_unknown(self):
        daily = [{"repo": "owner/b", "stars": 10, "trend_gain": 0,
                  "language": "", "desc": "", "topics": [], "source": "trending-daily"}]
        weekly = [{"repo": "owner/b", "stars": 10, "trend_gain": None,
                   "language": "", "desc": "", "topics": [], "source": "trending-weekly"}]

        def fake_parse(period):
            return daily if period == "daily" else weekly

        with patch.object(scan, "parse_trending", side_effect=fake_parse), \
             patch.object(scan, "search_new_repos", return_value=[]):
            merged, _ = scan.collect([])

        self.assertEqual(merged["owner/b"]["trend_gain"], 0,
                         "0 is a measurement; it must not be replaced by None")


class TestTrendGainTriState(unittest.TestCase):
    """trend_gain has three states; collapsing them loses information.

    None  = this source carries no daily velocity (weekly page, topic search)
    0     = measured, and it really did not move today
    n > 0 = measured growth
    """

    def test_max_gain_ignores_none(self):
        self.assertEqual(scan._max_gain(None, 500), 500)
        self.assertEqual(scan._max_gain(500, None), 500)
        self.assertEqual(scan._max_gain(500, 300), 500)
        self.assertIsNone(scan._max_gain(None, None))

    def test_max_gain_keeps_real_zero(self):
        # 0 is a measurement; it must beat "unknown", not lose to it.
        self.assertEqual(scan._max_gain(None, 0), 0)
        self.assertEqual(scan._max_gain(0, None), 0)

    def test_topic_source_reports_no_velocity(self):
        rows = scan.search_topic("dsh-plugin")
        if not rows:
            self.skipTest("gh unavailable")
        for row in rows:
            self.assertIsNone(row["trend_gain"])
            self.assertTrue(row["source"].startswith("topic:"))


class TestDshWatchlist(unittest.TestCase):
    def test_topic_constant_is_the_plugin_marker(self):
        self.assertEqual(scan.DSH_TOPIC, "dsh-plugin")

    def test_watchlist_is_not_merged_into_candidates(self):
        # A repo that is not trending must not enter topic_frequency, so the
        # watchlist has to travel as its own field.
        source = open(scan.__file__, encoding="utf-8").read()
        self.assertIn('"dsh_plugins": dsh_plugins', source)


class TestCollectorNeutrality(unittest.TestCase):
    """The collector must not know about the curated list.

    Which candidates are already collected is an analysis-side judgement
    (REPORT-CONTRACT.md §2) — keeping it out of the collector means the curated
    list can grow without a code change, and block 2 of the report can still
    see the repos it needs.
    """

    def test_module_has_no_collected_list(self):
        self.assertFalse(
            hasattr(scan, "COLLECTED"),
            "scan must stay neutral: the curated list belongs to the analysis side",
        )

    def test_curated_repo_still_reaches_candidates(self):
        merged = {"tailscale/tailscale": {"repo": "tailscale/tailscale", "desc": "", "trend_gain": 999}}
        noise, candidates = TestFiltering()._filter(merged)
        self.assertEqual(noise, [])
        self.assertEqual([c["repo"] for c in candidates], ["tailscale/tailscale"])


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
