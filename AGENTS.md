# AGENTS.md — Store Control Plane / Router

Any Agent (human or AI) modifying this repository MUST read, in order, before making changes:

1. `AGENTS.md` (this file — routing only)
2. `CONTRIBUTING_AI.md` (public contribution rules)
3. `PUBLISHING.md` (asset publishing protocol — when publishing an asset)
4. `VERSIONING.md` (store-wide versioning contract)
5. `SKILL-FORMAT.md` (asset format contract — the whitelist the external
   standards impose, plus what the Store adds on top)
6. `RETIREMENT.md` (how to end an asset — the one operation that shrinks the Store)
7. `registry.yaml` (top-level store router)
8. The README of the Domain being touched:
   - `orchestrations/README.md` for Orchestration Domain work
   - `skills/README.md` for Skill Domain work
   - `external-capabilities/README.md` for External Capability Domain work
   - `automations/README.md` for Automation Domain work
   - `dependencies/capability-map.yaml` for dependency work
9. The Domain Policy files of the touched area
   (e.g. `skills/LIFECYCLE.md`, `skills/ACCEPTANCE.md`, `external-capabilities/SECURITY.md`,
   `automations/LIFECYCLE.md`)
10. The current target entity (skill / capability / dependency record) before editing it

AGENTS.md is the Control Plane / Router. It does NOT duplicate policy.
Domain-specific policy lives in the Domain directories.

## Domain Routing

| Intent | Route |
|---|---|
| Add / change a Skill (how to do one thing) | `skills/` |
| Add / change an Orchestration (in what order several things run, for one task) | `orchestrations/` |
| Add / change an External Capability (plugin / MCP / connector / CLI / API / integration) | `external-capabilities/` |
| Add / change an Automation (scheduled or event-driven job) | `automations/` |
| Record a Skill ↔ External Capability dependency | `dependencies/capability-map.yaml` |
| Change store-wide policy | top-level policy files |

Skills, External Capabilities, Automations and Orchestrations are **peer Domains**.

What separates them is the question each one answers:

| Domain | Question |
|---|---|
| `skills/` | **how** to do one thing |
| `external-capabilities/` | **what** can be called |
| `automations/` | **when** something runs (a clock) |
| `orchestrations/` | **in what order** several of the above run, for one task |

An orchestration only **references** the other three — it holds no implementation, no rules
and no code. Changing how a step works still means changing it in its own Domain. A Plugin is NOT a
sub-entity of a Skill. An Automation is NOT a Capability: a capability is called, an
automation is triggered by a clock.

## Source of Truth

| State | Owner |
|---|---|
| Skill identity / path / lifecycle / version | `skills/registry.yaml` |
| External capability identity / provider / type / availability / auth / permissions / version / implementation | `external-capabilities/registry.yaml` |
| Skill ↔ External Capability dependencies | `dependencies/capability-map.yaml` |
| Automation identity / path / lifecycle / trigger / workflow / output | `automations/registry.yaml` |
| Store registry routing | `registry.yaml` (top level, router only) |

A single core fact is maintained in exactly one registry. Do not duplicate Domain state into the top level.
