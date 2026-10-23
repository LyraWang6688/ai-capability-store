# github-trending-daily

Collects what is rising on GitHub today, as structured facts. Produces no
conclusions — judging relevance is an Agent's job, done in DSH.

## Sources

| # | Source | Why |
|---|---|---|
| 1 | `https://github.com/trending?since=daily` | the only source carrying per-day velocity (`stars today`) |
| 2 | `https://github.com/trending?since=weekly` | catches repos that sustained a week, not a day |
| 3 | `gh search repos --created <7d ago> --stars >200` | new repos too fresh to trend yet |

Merged by repository, de-duplicated, then enriched with `topics` via `gh api`.

## Output contract

One JSON document on stdout:

```json
{
  "generated_at": "2026-10-17T19:20:00+08:00",
  "automation": "github-trending-daily",
  "total_scanned": 22,
  "warnings": [],
  "excluded_noise": ["..."],
  "topic_frequency": [{"topic": "mcp", "repos": 5}],
  "dsh_plugins": [{"repo": "owner/name", "stars": 1754, "trend_gain": null, "topics": ["dsh-plugin"]}],
  "candidates": [{"repo": "owner/name", "stars": 1234, "trend_gain": 56, "topics": ["mcp"]}]
}
```

Two fields carry a deliberate distinction:

- **`trend_gain` is nullable.** `null` means *this source carries no daily
  velocity* (the weekly page and the topic search have no "stars today"
  element); `0` means *measured, and it really did not move today*. Collapsing
  the two would make an unmeasured repo look flat — `morluto/rea` gained 11,701
  stars over two days while reporting `trend_gain: 0`, because it only ever
  appeared on the weekly page.
- **`dsh_plugins` is a watchlist, not a trend signal.** It comes from the
  `dsh-plugin` topic index, so it surfaces a project on day one instead of on
  the day it goes viral. It is deliberately **not** merged into `candidates`: a
  repo that is not trending must not enter `topic_frequency`. The topic is
  partly self-applied, so star count is the only ranking signal available.

The collector is deliberately **neutral about the curated list**: it does not
know which repos are already in the owner's Feishu table, so there is no
"already collected" field. That classification is the analysis side's job — see
[`REPORT-CONTRACT.md`](../REPORT-CONTRACT.md) §2.

`topic_frequency` is the field an Agent reads first: it answers *what the AI
ecosystem is paying attention to today* without any interpretation.

## Consumer side: sync_from_cloud.py

`sync_from_cloud.py` is the reader for this automation's `output.target: git-branch`
contract. It pulls `trending/<date>.json` from the `data` branch into a local
directory so an agent can read scheduled output — including on days the local
machine was off.

```bash
python3 sync_from_cloud.py --days 7 --json
```

Properties that matter:

- **`absent` and `unreadable` are different answers.** A 404 means the cloud
  really produced nothing that day; a timeout, an auth failure, or a rate limit
  means we do not know. The summary carries them separately
  (`absent_in_cloud` / `unreadable`) and exposes `today_status` as one of
  `available` / `absent` / `unreadable`. Collapsing the two produced a
  confidently wrong report on 2026-10-19 — the sync reported
  `today_available: false` while the file was sitting on the data branch.
  Unreadable days are retried once before being surfaced.
- **Never fatal.** The caller falls back to reporting "cloud data missing"; a sync
  failure must not become a task failure.
- **Never overwrites.** Only missing days are fetched, so a locally produced
  snapshot is never silently replaced by a cloud one.
- Uses `gh api` rather than raw HTTP: it works for private repositories and
  reuses the CLI's existing auth, so no token handling lives here.

The weekly automation reads the same branch and uses this same script.

### The report itself

`sync_from_cloud.py` only brings the data local. What the **report** must look
like is a separate contract — two blocks (new discoveries analysed on two
dimensions, plus status tracking for already-collected repos), the interests
mapping, the anti-fabrication rules, and the daily vs weekly judgement
differences:

- [`REPORT-CONTRACT.md`](../REPORT-CONTRACT.md) — the structure, non-negotiable rules
- [`interests.yaml`](../interests.yaml) — what the operator currently cares about,
  with the schema documented inline
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — how the whole pipeline runs end to end:
  what lives where, what a given change affects, and why the schedule prompt is a
  pointer rather than a copy

`interests.yaml` **is** in this repository on purpose: its content is technical
directions plus already-public project names, so it is not sensitive — and
keeping it here makes it versioned (you can see how the focus evolved),
reviewable, and portable across machines.

The contract is here rather than only in the agent's schedule prompt so the
structure is versioned and reviewable — a prompt living in a local
`~/.dsh/storages/schedule.json` disappears with the machine.

## Local use

```bash
python3 automations/github-trending/daily/scan.py --save-dir /path/to/trending
```

## Degradation, not failure

A dead source is recorded in `warnings` and the run still succeeds with the
remaining sources. Exit 0 means "the document is valid", not "all three sources
answered". An empty `candidates` array with a populated `warnings` array is a
real, readable state — never confuse it with "nothing is trending".

## Failure modes

| Symptom | Cause | Check |
|---|---|---|
| `candidates: []` and 3 warnings | no network / `gh` unauthenticated | `warnings` array |
| `topic_frequency: []` | `gh api` rate limited (60/hr unauthenticated) | `GH_TOKEN` present? |
| `stars` all `0` | GitHub changed the trending DOM | parse still yields `repo` |

## Why this is not a `skill`

A skill is a procedure an Agent follows when it decides to. This runs when a
clock fires. See `automations/README.md`.

## Delivery (2026-10-24)

Actions 只抓数据，通过 SSH 把 payload 推给服务器 DSH。服务器判断有无变化，
需要时调 DeepSeek 出报告，HTML 发布到：

```text
https://automation.bamamei.online/reports/github-trending-daily/<YYYY-MM-DD>.html
```

`data` 分支仍保留原始快照（给 weekly 聚合），它不是用户可见输出。
