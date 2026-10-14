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

## Placement

```text
external-capabilities/providers/<provider-name>/README.md
external-capabilities/use-cases/<use-case>.md
external-capabilities/mcp/<capability-name>/     # Store-managed MCP implementations
```

Use lowercase kebab-case for provider identifiers.

## Scope Policy — Store-managed only

**This Store accepts Store-managed capabilities ONLY** — code the Store itself
hosts and maintains. Third-party capabilities whose code lives elsewhere (pure
external connectors / APIs) are **NOT** registered here.

If that policy ever changes, the schema must gain an **explicit hosting
declaration** (a required enum field). Do not infer intent from a missing
`implementation_path` — that is precisely the ambiguity this policy removes.

Store-managed implementations live under
`external-capabilities/mcp/<capability-name>/`. Shelves for other types
(`cli/` / `connector/` / `api/` / `plugin/`) are created only when a real asset
needs them. The Store fixes the asset ROOT location only; it does NOT prescribe
the internal source layout of an MCP (Node / Python / Go projects keep their own
native structure).

## Registry

`external-capabilities/registry.yaml` is the machine-readable source of truth for:

- capability identity
- provider
- type
- availability status
- auth model
- permission model
- capabilities
- version (Store-recommended version)
- implementation (Store-managed code location)

A capability record requires:

- `name`          — capability identifier (lowercase kebab-case, == map key)
- `provider`      — the party that provides the underlying service this
                    capability depends on, and whose rules therefore bound what
                    it can do (lowercase kebab-case). See **Provider Semantics**.
- `type`          — one of: plugin / mcp / connector / cli / external-api / integration
- `status`        — one of: available / limited / disabled / unknown
- `provider_path` — `external-capabilities/providers/<provider>/README.md` (must exist)
- `version`       — semantic X.Y.Z (Store-recommended version; see `VERSIONING.md`)
- `implementation_path`
                  — relative repo path to the Store-managed code; must exist,
                    must be relative with no `../`, and must live under
                    `external-capabilities/`

> `version` and `implementation_path` are **required, not optional**. While they
> were optional, an entry that simply omitted `implementation_path` skipped
> every implementation check and still reported a clean run — pointing at no
> code at all. A missing field is now an error rather than a
> different-but-valid shape.

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

**`provider` is not a maintainer field.** This Store accepts Store-managed
capabilities only (see Scope Policy above), so every registered capability has
the same maintainer. A maintainer field would be constant and carry no
information; `provider` exists to record *which external rules apply*.

Worked example — `teaming-mcp` uses Feishu, an LLM service and a self-built
report server, yet its provider is `lyrawang`, not `feishu`: by design it never
calls Feishu itself (the host fetches the transcript and hands it over), so
Feishu's rules do not bound it. Its boundary comes from our own architecture.

`provider_path` points at `external-capabilities/providers/<provider>/README.md`,
which documents that party's official interfaces, auth model and constraints.

## Security

Authentication metadata ≠ credential storage. See [SECURITY.md](./SECURITY.md).

## Status Values

- `available`
- `limited`
- `disabled`
- `unknown`

## Add or Update Workflow

1. Check whether the plugin / provider already exists (Reuse Scan).
2. Inspect the current record.
3. Add or update only verified information.
4. Update `external-capabilities/registry.yaml`.
5. Update the provider README when details change.
6. Use a clear commit message (see `CONTRIBUTING_AI.md`).
