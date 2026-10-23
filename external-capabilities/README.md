# External Capability Domain — External Capabilities

**Domain: External Capabilities = What can be called**

An External Capability is an external tool or service the Agent may use to execute part of a workflow.

Includes:

- Plugin
- MCP server
- Connector
- CLI
- external API used as a tool
- authenticated application integration

## Peer Domains

```text
Skill                = How to do
External Capability  = What can be called
```

Skills and External Capabilities are **peer Domains**. A Plugin is NOT a sub-entity of a Skill.

> DSH 插件（plugin/dsh/*）的工程经验与已验证 API 清单，见
> [`plugin/dsh/README.md`](./plugin/dsh/README.md)。

## Placement

```text
external-capabilities/providers/<provider-name>/README.md
external-capabilities/use-cases/<use-case>.md
external-capabilities/mcp/<capability-name>/          # Store-managed MCP implementations
external-capabilities/connectors/<capability-name>/   # Store-managed connectors (deployments)
```

`providers/` and `use-cases/` hold **documents**. Every other directory here is a
**shelf**, and shelves are **closed**: each of its subdirectories must appear as
some registry entry's `implementation_path`.

A shelf is created when a real asset needs it — `connectors/` exists because
(`investdesk-bot` was a deployment, not a package — retired 2026-10 when the chat entry moved to Doubao Work.) A new shelf name must be declared
in `scripts/validate_store.py` (`CAPABILITY_SHELVES` or
`RESERVED_CAPABILITY_DIRS`); it should not arrive by someone creating a directory,
because adding a shelf is a policy decision worth reviewing.

Use lowercase kebab-case for provider identifiers.

## Scope Policy — two hosting shapes

Capabilities are classified by **where the code lives**, declared explicitly in a
required field `hosting`:

| `hosting` | Code | Registry must carry | Example |
|---|---|---|---|
| `store-managed` | in this repository | `implementation_path` (must exist under `external-capabilities/`) | `wechat-draft-mcp`, `teaming-mcp` |
| `external` | in a separate project we maintain | `endpoint` + `contract_path` (contract lives in this repository) | `meeting-analysis-service`, `readloop-service` |

**Why `external` exists.** A product whose backend is its own repository but whose
client-side skill is distributed here had nowhere to put the service: the skill
called it with a literal `curl`, and no registry knew the service existed. The
dependency could not be recorded in `capability-map.yaml` either, because the
capability it would point at could not be registered.

**Why it is not just "missing implementation_path".** A missing field is an
omission, not a declaration. `hosting` is required and closed: an entry either
declares `store-managed` (and is held to the old path checks) or declares
`external` (and is then **forbidden** from carrying `implementation_path`,
because that would claim the Store hosts code it does not host). The validator
enforces both directions.

The old policy — "Store-managed only" — existed to stop entries that point at
nothing. `external` keeps that guarantee by making the entry point at something
the Store *does* have: the contract. If a service's contract is not in this
repository, it is not registrable here.

### Ecosystem layer (`<shelf>/<ecosystem>/…`)

A shelf may hold one **optional** extra level for **ecosystems** — a group of assets that
are specific to one platform. Optional is the whole point: a general asset belongs flat at
its shelf.

```text
external-capabilities/plugin/dsh/
  selection-toolbar/    @lyra_wang/dsh-selection-toolbar
  image-ocr/            @lyra_wang/dsh-image-ocr
  feishu-ref/           @lyra_wang/dsh-feishu-ref
```

**Ecosystem names are a closed set** (`CAPABILITY_ECOSYSTEMS` in
`scripts/validate_store.py`), for the same reason shelves are: adding one is a
classification decision, not something that should arrive by someone creating a
directory.

The rules inside an ecosystem are exactly the shelf rules — kebab-case, and every
directory must be pointed at by some registry entry. A directory nobody registered is an
asset nobody governs, whichever depth it sits at.

#### The test: specific, or general?

> **Remove the ecosystem — does this asset still make sense?**

| Answer | Where it goes | Example |
|---|---|---|
| **No** | **inside** the ecosystem | `selection-toolbar` without DSH is a JS file with nowhere to load. It exists only as a DSH plugin. |
| **Yes** | **flat**, at the shelf | `command-sync` reads zsh history and works in any setup. Nothing about it depends on one platform. |

**An ecosystem is not a promotion and not a sign of quality.** It is a statement that the
asset is *specific to a platform*. Filing a general asset under an ecosystem makes it
**harder** to find, because the reader has to know which platform to look under for
something that does not belong to any of them.

**Most assets are general.** File under an ecosystem only when the "remove it" test comes
back No.

Current ecosystems: `dsh` — three plugins whose npm names are `@lyra_wang/dsh-*`. The
kinship is written in the package names, not inferred.

Store-managed implementations live under a **shelf**: `mcp/` for MCP servers,
`connectors/` for deployments that connect two systems rather than expose tools,
and `cli/` / `api/` / `plugin/` when a real asset of that shape appears. The
Store fixes the asset ROOT location only; it does NOT prescribe the internal
source layout of an implementation (Node / Python / Go projects keep their own
native structure).

Shelves are closed on purpose. Before this rule, `connectors/investdesk-bot` —
fourteen files including a Dockerfile, a compose file and a deploy script — sat
in the tree with no registry entry. (That asset was later retired when the chat
entry moved to Doubao Work; the episode is kept here as the reason for the rule.) Every schema check iterates entries, so
nothing looked at it; every tag check does too. The validator reported a clean
run. A directory nobody registered is an asset nobody governs, which is the one
thing this Store exists to prevent.

## Registry

`external-capabilities/registry.yaml` is the machine-readable source of truth for:

- capability identity
- provider
- type
- hosting (where the code lives)
- availability status
- auth model
- permission model
- capabilities
- version (Store-recommended version)
- implementation (Store-managed code location) **or** endpoint + contract (external)

A capability record requires:

- `name`          — capability identifier (lowercase kebab-case, == map key)
- `provider`      — the party that provides the underlying service this
                    capability depends on, and whose rules therefore bound what
                    it can do (lowercase kebab-case). See **Provider Semantics**.
- `type`          — one of: plugin / mcp / connector / cli / external-api / integration
- `hosting`       — `store-managed` or `external`; decides which block below applies
- `status`        — one of: available / limited / disabled / unknown
- `provider_path` — `external-capabilities/providers/<provider>/README.md` (must exist)
- `version`       — semantic X.Y.Z (Store-recommended version; see `VERSIONING.md`)

Then exactly one of:

- `implementation_path` (hosting: store-managed)
                  — relative repo path to the Store-managed code; must exist,
                    must be relative with no `../`, and must live under
                    `external-capabilities/`
- `endpoint` + `contract_path` (hosting: external)
                  — the service base URL (https) and the repository path holding
                    its interface contract. `implementation_path` is forbidden
                    here: the code lives in a separate project, and claiming a
                    Store path would describe code the Store does not host.

> These fields are **required, not optional**, and `hosting` is required too.
> While `implementation_path` was optional, an entry that simply omitted it
> skipped every implementation check and still reported a clean run — pointing
> at no code at all. `hosting` closes the other half of the same hole: an entry
> may not become "external" by leaving a field out; it must say so.

Optional, when known:

- `auth`          — authentication model (metadata only)
- `capabilities`  — what the capability can do
- `permissions`   — verified permissions only
- `notes`         — free-form notes

Do not invent unknown permissions or authentication methods.

## Provider Semantics

`provider` names **the party that provides the underlying service** — the side
whose rules bound what the capability can do.

| The capability's boundary is set by… | `provider` |
|---|---|
| a third-party platform's API, quota and permission model | that platform (`feishu`, `wechat`) |
| our own design | the Store owner (`lyrawang`) |

The test is: **who decides what this capability can do?** If the answer is "the
platform's API", the provider is the platform. If the answer is "our own
design", it is the self-provider.

**`provider` is not a maintainer field.** This Store accepts only capabilities we
ourselves maintain (code in the Store, or a service of our own with its contract
in the Store — see Scope Policy above), so every registered capability has the
same maintainer. A maintainer field would be constant and carry no
information; `provider` exists to record *which external rules apply*.

Worked example — `teaming-mcp` uses Feishu, an LLM service and a self-built
report server, yet its provider is `lyrawang`, not `feishu`: by design it never
calls Feishu itself (the host fetches the transcript and hands it over), so
Feishu's rules do not bound it. Its boundary comes from our own architecture.

`provider_path` points at `external-capabilities/providers/<provider>/README.md`,
which documents that party's official interfaces, auth model and constraints.

## Security

Authentication metadata ≠ credential storage. See [SECURITY.md](./SECURITY.md).

Capabilities that move work across a trust boundary — a remote message causing local
execution, or local content leaving the machine — have requirements of their own in
[SECURITY.md § Remote-Triggered Execution](./SECURITY.md#remote-triggered-execution).

## Status Values

A capability's status answers **"can it be used right now?"** — and, for
`archived` only, also **"is it still maintained?"**. Those are two different
questions, and collapsing them is why `disabled` alone was not enough.

| Status | Meaning | Reversible? |
|---|---|---|
| `available` | Works for its documented scope, with the declared credentials. | — |
| `limited` | Works, but bounded — a subset of its surface, an environment requirement (a local runtime, a keychain token, a whitelisted egress IP), or a known-unstable upstream. | yes |
| `disabled` | Temporarily unusable: a switch is off, a service is down, an account limit is in effect. **The asset is still maintained.** | yes |
| `unknown` | Not verified yet. Recorded from someone's description rather than from use; treat it as `disabled` when deciding whether to call it. | yes |
| `archived` | Permanently retired. Not maintained, not to be chosen for new work, kept only so its history stays answerable. **This is a statement about the asset, not about the moment** — do not flip it back; a revived capability is a new asset. | no |

`disabled` → `archived` is the retirement path. Before it, a capability could be
switched off but never laid to rest, while Skills and Automations had
`deprecated` / `archived` all along.

Archiving does not delete anything by itself: the tag stays (tags are immutable),
and the directory stays until a separate decision removes it — `RETIREMENT.md`
describes that ladder and what survives it. Record **why** in `notes` — an archived
capability with no reason is indistinguishable from one that was abandoned by
accident.

## Add or Update Workflow

1. Check whether the plugin / provider already exists (Reuse Scan).
2. Inspect the current record.
3. Add or update only verified information.
4. Update `external-capabilities/registry.yaml`.
5. Update the provider README when details change.
6. Use a clear commit message (see `CONTRIBUTING_AI.md`).
