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

## Executor: who runs it

`executor` names the runner, and it is a **separate axis from `trigger_kind`**:

| | question | values |
|---|---|---|
| `trigger_kind` | how often | `daily` / `weekly` / `monthly` / `manual` / `event` |
| `executor` | what runs it | `github-actions` / `launchd` / `human` |

Each executor requires **exactly its own descriptor** and no other:

| `executor` | required | forbidden |
|---|---|---|
| `github-actions` | `workflow:` | `launchd:` |
| `launchd` | `launchd: {label, template}` | `workflow:` |
| `human` | neither | both |

"Exactly" is enforced, not just "at least": an automation carrying both a
workflow and a launchd block is two jobs described as one, and the registry would
answer *"what runs this?"* with two incompatible answers.

`launchd.label` must also appear as `<string>label</string>` inside the plist
template — an installed job whose `Label` disagrees with the registry is a job
nobody is tracking.

Why `launchd` exists at all: a runner that needs a credential living in the
operator's own keychain cannot be moved to a hosted runner. Naming that executor
honestly is better than pretending every automation runs in CI.

## The cron lives in exactly one place

For a `github-actions` automation, `registry.yaml` records **`trigger_kind`**
(`daily` / `weekly` / `monthly` / `manual` / `event`), never the cron expression.
The authoritative schedule is the `on:` block of the **bound workflow file** named
by `workflow:`. A `launchd` automation's schedule lives in its plist template for
the same reason.

Why: a cron copied into two files drifts. The validator instead checks that the
workflow exists, is bound correctly, and carries a `schedule:` trigger when
`trigger_kind` is not `manual`.

## Where output goes

`output.target` says what kind of place the output lands in:

| `target` | required fields | meaning |
|---|---|---|
| `git-branch` | `branch` (must be `data`), `path_pattern` | machine output committed to a branch |
| `external-system` | `destination` | written into a system this repository does not own |

**`git-branch` output goes to the `data` branch, never to `main`.** Automations
produce high-frequency data; committing that to `main` would bury the Store's
asset history — one year of daily snapshots is ~365 commits of machine output.
`main` carries code, contracts, and reviewable changes.

**`external-system` output is not validated here** beyond requiring a specific
`destination`. When the destination is another tenant's database, a validator in
this repository can only record the claim — it cannot verify it. Do not read a
passing validation as proof that the external write works.

## Adding an automation

1. Create `automations/<kebab-name>/` with a `README.md` and an entrypoint.
2. Decide `executor` and `trigger_kind` — they are independent, and the executor
   chosen decides which runner descriptor you must add (`workflow` or `launchd`).
3. Add the runner descriptor:
   - `github-actions` → `.github/workflows/automation-<kebab-name>.yml`
   - `launchd` → a plist **template** under `automations/<name>/deploy/`, plus
     an installer that writes the real plist to `~/Library/LaunchAgents/`
4. Add a record to `automations/registry.yaml`.
5. Run `python3 scripts/validate_store.py` — it enforces registry ↔ filesystem
   symmetry, kebab-case naming, entrypoint existence, executor/descriptor
   agreement, workflow binding, plist label agreement, and the output contract.
