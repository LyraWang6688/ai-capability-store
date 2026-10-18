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
  "candidates": [{"repo": "owner/name", "stars": 1234, "trend_gain": 56, "topics": ["mcp"]}]
}
```

The collector is deliberately **neutral about the curated list**: it does not
know which repos are already in the owner's Feishu table, so there is no
"already collected" field. That classification is the analysis side's job — see
[`REPORT-CONTRACT.md`](./REPORT-CONTRACT.md) §2.

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

- **Never fatal.** The caller falls back to reporting "cloud data missing"; a sync
  failure must not become a task failure.
- **Never overwrites.** Only missing days are fetched, so a locally produced
  snapshot is never silently replaced by a cloud one.
- Uses `gh api` rather than raw HTTP: it works for private repositories and
  reuses the CLI's existing auth, so no token handling lives here.

The weekly automation reads the same branch and uses this same script.

### The report itself

`sync_from_cloud.py` only brings the data local. What the **report** must look
like — the three dimensions (community focus → underlying problem → relation to
the operator's interests), the interests mapping, the 2×2 positioning matrix, and
the anti-fabrication rules — is a separate contract:

- [`REPORT-CONTRACT.md`](./REPORT-CONTRACT.md) — the structure, non-negotiable rules
- [`interests.yaml`](./interests.yaml) — what the operator currently cares about,
  with the schema documented inline

`interests.yaml` **is** in this repository on purpose: its content is technical
directions plus already-public project names, so it is not sensitive — and
keeping it here makes it versioned (you can see how the focus evolved),
reviewable, and portable across machines.

The contract is here rather than only in the agent's schedule prompt so the
structure is versioned and reviewable — a prompt living in a local
`~/.dsh/storages/schedule.json` disappears with the machine.

## Local use

```bash
python3 automations/github-trending-daily/scan.py --save-dir /path/to/trending
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
