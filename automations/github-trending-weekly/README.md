# github-trending-weekly

Turns seven daily snapshots into trend signal: what **persisted** versus what
merely **spiked**.

## Why this exists

`trend_gain` (stars in one day) peaks on launch day and then collapses. It
measures attention, not adoption. A repository that is actually being used keeps
gaining stars across the week — and only a time series reveals that.

```
trend_gain     one day     ← launch-day spike, noisy
star_delta     7 days      ← sustained adoption, reliable
```

`star_delta` requires history, which is why the daily automation must run first.

## The report this feeds

This script only produces the *inputs* for a trend report. What the report must
look like — the two blocks, the interests mapping, and the **weekly-specific
judgement differences** — is defined by a shared contract that covers both the
daily and the weekly automation:

- [`../github-trending-daily/REPORT-CONTRACT.md`](../github-trending-daily/REPORT-CONTRACT.md)
  — the report structure. Read the section named **「周报的差异」** for what
  differs from the daily (use `star_delta`, not `peak_daily_gain`; look for
  cross-week movement; respect the `trustworthy` gate).
- [`../github-trending-daily/ARCHITECTURE.md`](../github-trending-daily/ARCHITECTURE.md)
  — how the whole pipeline runs end to end, and what a given change affects.

The contract lives in the *daily* directory because the daily automation owns the
data collection, the interests file, and the shared report shape; the weekly
extends it rather than defining its own.

> Referenced by section **name**, not number — the contract gains and loses
> sections, and a hard-coded `§N` silently rots (it did once: the weekly prompt
> pointed at §6 while 「周报的差异」 had moved to §7).


## Input

`<data-dir>/<YYYY-MM-DD>.json` written by `github-trending-daily`.
`weekly-*.json` files in the same directory are ignored.

## Output contract

```json
{
  "days_with_data": 7,
  "days_missing": [],
  "trustworthy": true,
  "note": "window complete",
  "topics_persistent": [{"topic": "mcp", "days_present": 7, "verdict": "persistent"}],
  "topics_emerging":   [{"topic": "agent-ide", "days_present": 1, "verdict": "emerging"}],
  "repos_sustained":   [{"repo": "owner/name", "days_seen": 6, "star_delta": 2400}],
  "repos_climbing_by_stars": ["..."],
  "repos_one_day_wonders":   ["..."]
}
```

## The honesty gate

With fewer than 3 days of data the output sets `trustworthy: false` and says so
in `note`:

```json
{"days_with_data": 2, "trustworthy": false,
 "note": "insufficient data: 2 day(s) in window; a trend claim would be unfounded"}
```

It **never** manufactures a trend from two points. Downstream (DSH) must honour
`trustworthy` and report the gap rather than a conclusion.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | aggregate on stdout (may still carry `trustworthy: false`) |
| 2 | no usable snapshot at all — the data branch is empty or the window is wrong |

## Local use

```bash
python3 automations/github-trending-weekly/aggregate.py --data-dir /path/to/trending
```
