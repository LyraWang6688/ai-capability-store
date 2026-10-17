# data — machine-generated automation output

**This branch holds data, not code.** It is written by scheduled GitHub Actions
and never edited by hand.

## Why a separate branch

`ai-capability-store` on `main` is a curated capability registry. Every commit
there should be a reviewable change to an asset. Automation output is the
opposite: high-frequency, machine-produced, never reviewed.

Committing daily snapshots to `main` would bury the asset history — one year of
daily collection is roughly 365 commits of JSON. So `main` keeps the code and
the data lives here.

The contract is stated in `automations/README.md` on `main`, and enforced by
`scripts/validate_store.py` (every automation's `output.branch` must be `data`).

## Layout

```
trending/
├── <YYYY-MM-DD>.json        # daily snapshot   → automations/github-trending-daily
└── weekly-<YYYY-MM-DD>.json # weekly aggregate → automations/github-trending-weekly
```

## How to read it

```bash
# latest daily snapshot
gh api repos/LyraWang6688/ai-capability-store/contents/trending \
  -f ref=data --jq '.[].name' | tail -1
```

## Retention

Snapshots are append-only. Nothing prunes them automatically yet; if the branch
grows large the daily automation should start pruning to a rolling window.

## Do not merge this branch into main

It shares no history with `main` on purpose. Merging it would dump machine data
into the curated registry.
