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
├── <name>/            ← one automation, kebab-case        (flat — the common shape)
│   ├── README.md      ← what it does, inputs, outputs, failure modes
│   └── <entrypoint>   ← the executable named by registry `entrypoint`
└── <family>/          ← a group of related automations    (see "Families")
    ├── README.md      ← why these members live together (required)
    ├── <shared file>  ← contract / data every member uses
    └── <member>/      ← one automation; registry key is `<family>-<member>`
```

Exactly two shapes are legal, and nothing else: `automations/<name>/` and
`automations/<family>/<member>/`.

## Families — one level, shared files only

A family exists for one situation: **two or more automations that must share files**
(a report contract, an `interests.yaml`, an architecture doc) and would otherwise
reach into each other's directory.

```text
automations/github-trending/       ← family container — NOT a registry entry
├── README.md                      ← required: why these members live together
├── REPORT-CONTRACT.md             ← shared: the report's content contract
├── interests.yaml                 ← shared: what the operator currently cares about
├── daily/                         ← registry key: github-trending-daily
│   ├── README.md
│   └── scan.py
└── weekly/                        ← registry key: github-trending-weekly
    ├── README.md
    └── aggregate.py
```

A family is **not an asset**:

| | asset (an automation) | family |
|---|---|---|
| registry entry | yes | **no** |
| `version` / tag | yes | **no** |
| `entrypoint` / `trigger_kind` | yes | **no** |
| gets executed | yes | **no** |
| has `status` | yes | **no** |

Its only two jobs are to hold shared files and to bound its members.

### The five rules

1. **One level, never two.** `automations/<family>/<member>` is the deepest legal
   path. Deeper nesting makes "what does this tag contain?" unanswerable.
2. **The key stays derivable in both directions.** A member's registry key is
   `<family>-<member>` — `github-trending` + `daily` → `github-trending-daily` —
   while a flat asset keeps `key == directory name`. One thing never gets two
   names. (This is also why tags do not change: `github-trending-daily-v0.1.0`
   stays correct after a family migration.)
3. **Files at the family level; directories are members, with no third option.**
   A family may hold `README.md`, contracts and data. It may **not** hold a shared
   code directory — a subdirectory is a registered member or it is a mistake. If
   shared code is ever genuinely needed, add an explicitly reserved name to
   `NON_ASSET_DIR_NAMES` in `scripts/validate_store.py` rather than widening this
   rule: "some subdirectories are not members" turns a family into a drawer.
4. **`README.md` is required.** A family has no key, no version and no tag, so the
   README is the only place that can record why it exists. Without one the
   container is a directory with no reason to be.
5. **A registered path may not nest inside another.** The validator stops walking
   at a registered directory (an asset owns its own internal layout), so anything
   nested under one would never be checked.

### What a family does to versions

**Tags still pin shared files.** `git checkout github-trending-daily-v0.1.0`
restores the whole tree at that commit, shared contract included. The
immutable-snapshot property is unchanged.

What is **not** enforced: that editing a shared file bumps its members' versions.
The validator is pure-filesystem and cannot see a diff. Treat it as a contract
obligation — a change under the family's own files bumps at least the PATCH
version of every member whose behaviour it affects.

### Why only this Domain

`skills/` cannot do this: agent-plugins.org §7.1 requires the flat position and
forbids recursion, so a nested skill is uninstallable, not merely unconventional.
`external-capabilities/` has no such constraint but also no such need — `providers/`
and `use-cases/` are already reserved non-asset shelves there.

`automations/` is the Store's own invention, has no external standard to satisfy,
and the shared-file pressure was real: before this rule, `github-trending-weekly`'s
README linked to `../github-trending-daily/REPORT-CONTRACT.md`. That link is what a
family is for.

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

1. Create `automations/<kebab-name>/` with a `README.md` and an entrypoint — or,
   if it must share files with a sibling, `automations/<family>/<member>/` and put
   the shared files at the family level (see "Families").
2. Decide `executor` and `trigger_kind` — they are independent, and the executor
   chosen decides which runner descriptor you must add (`workflow` or `launchd`).
3. Add the runner descriptor:
   - `github-actions` → `.github/workflows/automation-<kebab-name>.yml`
   - `launchd` → a plist **template** under `automations/<name>/deploy/` (or
     `automations/<family>/<member>/deploy/`), plus an installer that writes the
     real plist to `~/Library/LaunchAgents/`
4. Add a record to `automations/registry.yaml`.
5. Run `python3 scripts/validate_store.py` — it enforces registry ↔ filesystem
   symmetry, kebab-case naming, entrypoint existence, executor/descriptor
   agreement, workflow binding, plist label agreement, and the output contract.
