#!/usr/bin/env python3
"""Deterministic offline tests for scan.py — no network, no gh.

Run: python3 automations/github-trending-daily/test_scan.py
Exit: 0 all pass, 1 any failure.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
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

    def test_missing_optional_fields_degrade_to_zero(self):
        # A repo with no stargazers link and no "stars today" must not raise.
        payload = '<article><h2><a href="/a/b">a / b</a></h2></article>'
        rows = self._parse(payload)
        self.assertEqual(rows[0]["stars"], 0)
        self.assertEqual(rows[0]["trend_gain"], 0)
        self.assertEqual(rows[0]["language"], "")


class TestFiltering(unittest.TestCase):
    def _filter(self, merged):
        """Reproduce main()'s filtering without touching the network."""
        excluded_collected, excluded_noise, candidates = [], [], []
        for repo, item in merged.items():
            if repo in scan.COLLECTED:
                excluded_collected.append(repo)
                continue
            blob = f"{repo} {item['desc']}".lower()
            if any(m in blob for m in scan.NOISE_MARKERS) and item["trend_gain"] < 300:
                excluded_noise.append(repo)
                continue
            candidates.append(item)
        return excluded_collected, excluded_noise, candidates

    def test_collected_repository_is_excluded(self):
        merged = {"tailscale/tailscale": {"repo": "tailscale/tailscale", "desc": "", "trend_gain": 999}}
        collected, _, candidates = self._filter(merged)
        self.assertEqual(collected, ["tailscale/tailscale"])
        self.assertEqual(candidates, [])

    def test_noise_below_threshold_is_excluded(self):
        merged = {"someone/ai-job-search": {"repo": "someone/ai-job-search", "desc": "", "trend_gain": 10}}
        _, noise, candidates = self._filter(merged)
        self.assertEqual(noise, ["someone/ai-job-search"])
        self.assertEqual(candidates, [])

    def test_noise_with_big_gain_survives(self):
        merged = {"someone/ai-job-search": {"repo": "someone/ai-job-search", "desc": "", "trend_gain": 900}}
        _, noise, candidates = self._filter(merged)
        self.assertEqual(noise, [])
        self.assertEqual(len(candidates), 1)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
