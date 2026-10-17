# Automation Domain

Scheduled and event-driven automations that run against the Store owner's
GitHub account — data collection, aggregation, and recurring maintenance.

## What belongs here

| Belongs here | Does NOT belong here |
|---|---|
| A recurring job that runs on a schedule and produces data | A procedure an Agent follows (→ `skills/`) |
| A job whose schedule and output contract must be reviewable | A callable capability/MCP/CLI (→ `external-capabilities/`) |
| A job that can run unattended in CI | Anything that needs human judgement to execute |

An automation is **execution**, not **capability**: the difference is the trigger.
A skill runs because an Agent decided to; an automation runs because a clock fired.

## Layout

```
automations/
├── README.md          ← this file (domain contract)
├── LIFECYCLE.md       ← status policy
├── registry.yaml      ← source of truth for identity/path/status/version/trigger/workflow
└── <name>/            ← one directory per automation, kebab-case
    ├── README.md      ← what it does, inputs, outputs, failure modes
    └── <entrypoint>   ← the executable named by registry `entrypoint`
```

## Source of truth

`automations/registry.yaml` owns every automation's identity, path, lifecycle
status, version, trigger kind, bound workflow, and output contract. Nothing is
duplicated into `registry.yaml` at the repository root — the root file routes only.

An automation is a **peer Domain**, so it carries the same version discipline as a
Skill or an External Capability: every published version gets an annotated
`<automation-name>-vX.Y.Z` tag (`VERSIONING.md` §6), and the version bump ships in
the same PR as the change. Being scheduled does not exempt it — a job that runs
unattended is exactly the thing you may need to roll back. Run
`skills/store-publish/scripts/check_tag_version.py` before tagging.

## The cron lives in exactly one place

`registry.yaml` records **`trigger_kind`** (`daily` / `weekly` / `manual` /
`event`), never the cron expression. The authoritative schedule is the `on:`
block of the **bound workflow file** named by `workflow:`.

Why: a cron copied into two files drifts. The validator instead checks that the
workflow exists, is bound correctly, and carries a `schedule:` trigger when
`trigger_kind` is not `manual`.

## Output goes to the `data` branch, never to `main`

Automations produce high-frequency data. Committing that to `main` would bury
the Store's asset history — one year of daily snapshots is ~365 commits of
machine output.

**Contract:** automation output is committed to the `data` branch only.
`main` carries code, contracts, and reviewable changes.

## Adding an automation

1. Create `automations/<kebab-name>/` with a `README.md` and an entrypoint.
2. Add a record to `automations/registry.yaml`.
3. Add a workflow at `.github/workflows/automation-<kebab-name>.yml`.
4. Run `python3 scripts/validate_store.py` — it enforces registry ↔ filesystem
   symmetry, kebab-case naming, entrypoint existence, and workflow binding.
