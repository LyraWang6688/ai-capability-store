# AGENTS.md — Store Control Plane / Router

Any Agent (human or AI) modifying this repository MUST read, in order, before making changes:

1. `AGENTS.md` (this file — routing only)
2. `CONTRIBUTING_AI.md` (public contribution rules)
3. `PUBLISHING.md` (asset publishing protocol — when publishing an asset)
4. `COMMERCE.md` (is the asset sold, how, and what enforces it — when deciding
   or changing whether an asset is charged for)
5. `VERSIONING.md` (store-wide versioning contract)
6. `SKILL-FORMAT.md` (asset format contract — the whitelist the external
   standards impose, plus what the Store adds on top)
7. `RETIREMENT.md` (how to end an asset — the one operation that shrinks the Store)
8. `registry.yaml` (top-level store router)
9. The README of the Domain being touched:
   - `orchestrations/README.md` for Orchestration Domain work
   - `skills/README.md` for Skill Domain work
   - `procedures/README.md` for Procedure Domain work
   - `external-capabilities/README.md` for External Capability Domain work
   - `automations/README.md` for Automation Domain work
   - `dependencies/capability-map.yaml` for dependency work
10. The Domain Policy files of the touched area
    (e.g. `skills/LIFECYCLE.md`, `skills/ACCEPTANCE.md`, `external-capabilities/SECURITY.md`,
    `automations/LIFECYCLE.md`)
11. The current target entity (skill / capability / dependency record) before editing it

**Handoffs do NOT go into this repository.** They describe internal coordinates — server
addresses, Feishu base/table tokens, deployment paths, session ids. None of that is a
credential, but listing "which machine runs what" in a public repo hands out a map.

A handoff lives **next to the work it describes**, gitignored, and stays on the machine:
`orchestrations/<project>/<task>/HANDOFF.md` is the shape, not a tracked file.

AGENTS.md is the Control Plane / Router. It does NOT duplicate policy.
Domain-specific policy lives in the Domain directories.

## 待观察事项

- `dsh-html-annotate` 的 `direct: true` 预览：iframe 直接加载目标站，跨域无法在整页跳转后重新注入批注脚本；换页按钮消失。非 direct 代理模式已修复。详见 `external-capabilities/plugin/dsh/html-annotate/README.md` § 已知限制 → direct: true 的换页边界。待观察后再决定是否在预览服务侧加反向代理注入。

## Domain Routing

| Intent | Route |
|---|---|
| Add / change a Skill (how to do one thing — model decides) | `skills/` |
| Add / change a Procedure (how to do one thing — machine executes) | `procedures/` |
| Add / change an Orchestration (in what order several things run, for one task) | `orchestrations/` |
| Add / change an External Capability (plugin / MCP / connector / CLI / API / integration) | `external-capabilities/` |
| Add / change an Automation (scheduled or event-driven job) | `automations/` |
| Record a Skill ↔ External Capability dependency | `dependencies/capability-map.yaml` |
| Change store-wide policy | top-level policy files |

There are **three module Domains** and **one composition layer**.

| Layer | Directories | Holds |
|---|---|---|
| Module | `skills/` `procedures/` `external-capabilities/` | independent, reusable units — everything an orchestration may reference |
| Composition | `orchestrations/` | order + trigger + output; holds no implementation of its own |

A module Domain is a unit of *identity*: it has its own registry, lifecycle, version and
tag. The composition layer has none of those for itself — it only references.

`automations/` is being absorbed into `orchestrations/<project>/<task>/` because a job is
"trigger + an ordered set of modules + output", which is exactly what an orchestration
records. It stays registered during the migration; the layout rule is
`orchestrations/README.md` § 布局：两层, and whether a job is started by a clock or by a
human is the record's `trigger` field, not a directory level.

What separates them is the question each one answers:

| Domain | Question |
|---|---|
| `skills/` | **how** to do one thing — executed by a model, so it needs judgment |
| `procedures/` | **how** to do one thing — executed by a machine, so it is deterministic |
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
| Procedure identity / path / lifecycle / version / entrypoint / runtime | `procedures/registry.yaml` |
| External capability identity / provider / type / availability / auth / permissions / version / implementation | `external-capabilities/registry.yaml` |
| Skill ↔ External Capability dependencies | `dependencies/capability-map.yaml` |
| Automation identity / path / lifecycle / trigger / workflow / output | `automations/registry.yaml` |
| Asset commerce (charge / model / carrier / value) | the asset's own record in its Domain registry — no separate registry |
| Store registry routing | `registry.yaml` (top level, router only) |

A single core fact is maintained in exactly one registry. Do not duplicate Domain state into the top level.

## Local Consumption — the Store is the Only Source

This machine develops assets **only here**. An asset's source must exist exactly once:
in this repository. Local machines consume published artifacts, never a second copy of the source.

### Hard rules

| Rule | Meaning |
|---|---|
| No source copies outside the Store | No clones, vendored copies, "temp" dev directories, or backups of an asset's code under `~/Documents`, `~/Desktop`, or another project. |
| Local use goes through npm | CLIs, plugins and MCP servers are installed from the published package (`npm i -g --prefix ~/.local @lyra_wang/<pkg>@<version>`), not by running a path inside this repository. |
| DSH plugins via npm only | `dsh plugin --profile <p> add <npm-tarball-or-name>`. Installing by local path is a development shortcut only and must be removed before the work is done. |
| Runtime directories hold data, not code | `~/.command-sync`, `~/.mac-cleanup`, `~/.dsh-feishu-remote`, `~/.ai-quote-clip`, `~/.config/chrome-frequent-pages` may hold config, logs and snapshots. Any script in them must be a **symlink** to the installed npm package, never a copied file. |
| Skills are the one documented exception | `~/.agents/skills/<name>` is a symlink into `skills/<name>`. Skills are declarative files an agent reads, not executable packages. Publish a Skill to npm only when a non-local consumer needs it (`npx skills add`). |
| Local-only skills live outside | A skill that is internal tooling, not a distributable asset, has its **only source** at `~/.agents/skills/<name>` (a real directory). It has no registry entry, version or tag. `skills/<name>` may be a **gitignored symlink** to it for local visibility — never committed, and skipped by the validator's package discovery. Create it with `python3 scripts/link_local_skill.py <name>`; see `skills/README.md` § local-only. |

### Upgrade procedure

```
edit here → bump version (+ registry + tag) → npm publish → install from npm → restart / rerun the asset's install command
```

For command-sync, rerun `command-sync install` after upgrading so `~/.command-sync/bin/palette.py`
is re-linked to the new npm package.

### Audit checklist (run before calling the work done)

```bash
# 1) no source copies outside the Store
find ~/Documents/workplace -maxdepth 4 \( -name .git -o -path "*ai-capability-store*" \) -prune -o \
  -type d \( -name selection-toolbar -o -name feishu-ref -o -name image-ocr -o -name command-sync \
  -o -name ai-quote-clip -o -name mac-cleanup \) -print

# 2) installed packages are real npm installs, not symlinks into this repo
ls -la ~/.local/lib/node_modules/@lyra_wang
ls -la ~/.local/bin/{chrome-frequent-pages,command-sync,mac-cleanup,ai-quote-clip}

# 3) runtime scripts are symlinks, not copies
ls -la ~/.command-sync/bin
```
