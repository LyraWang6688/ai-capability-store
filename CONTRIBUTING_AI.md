# AI Contribution Protocol — Public Rules

This file defines the required operating rules for any AI system modifying this repository.

## Mandatory Read Order

Before making changes:

1. Read `AGENTS.md`.
2. Read `CONTRIBUTING_AI.md` (this file).
3. Read `PUBLISHING.md` when publishing an asset.
4. Read `VERSIONING.md` (store-wide versioning contract).
5. Read `registry.yaml` (top-level store router).
6. Read the README of the Domain being touched:
   - Skills work → `skills/README.md`
   - External Capability work → `external-capabilities/README.md`
7. Read the Domain Policy of the touched area
   (LIFECYCLE / VERSIONING / ACCEPTANCE / SECURITY as applicable).
8. Inspect the current target entity before editing it.

Do not create, move, rename, deprecate, or archive an entity without checking its registry first.

## Reuse Scan

Before adding anything, determine whether the requested capability already exists in:

- `skills/registry.yaml`
- `external-capabilities/registry.yaml`
- `dependencies/capability-map.yaml`

Do not create duplicates.

## Domain Routing

- **Skill** (reusable procedure / workflow / capability logic) → `skills/`
- **External Capability** (plugin / MCP / connector / CLI / external API / integration) → `external-capabilities/`
- **Skill ↔ External Capability dependency** → `dependencies/capability-map.yaml`
- **Store-wide policy** → top-level policy files

Skills and External Capabilities are **peer Domains**. A Plugin is NOT a sub-entity of a Skill.

## Native Protocol vs Store Governance

The Store does NOT redefine native protocols:

- **Skill Protocol** defines how a Skill describes and runs itself.
- **MCP Protocol** defines MCP Client/Server interaction.
- The Store governs only: placement / identity / registry / version / dependency / validation / publishing / lifecycle / history / distribution metadata.

Native Protocol ≠ Store Governance.

## Naming Rules

Use lowercase kebab-case for:

- project directories
- skill directories
- capability / provider identifiers
- machine-readable identifiers

Examples:

```text
meeting-agent
meeting-analysis
web-research
```

## Scope Control

- Make the smallest coherent change.
- Do not change unrelated files.
- Preserve Git history; do not silently overwrite unrelated work.

## Secret Protection

Do not store secrets, tokens, cookies, passwords, client secrets, or private credentials in this repository — in any file, commit message, or history.

Allowed: authentication **metadata** (auth type, required scopes, permission description, secret reference name).
Never allowed: secret **values**.

See `external-capabilities/SECURITY.md` for the full policy.

## Source of Truth

| State | Owner |
|---|---|
| Skill identity / path / lifecycle / version | `skills/registry.yaml` |
| External capability identity / provider / type / availability / auth / permissions | `external-capabilities/registry.yaml` |
| Skill ↔ External Capability dependencies | `dependencies/capability-map.yaml` |
| Store registry routing | `registry.yaml` (top level, router only) |

A single core fact is maintained in exactly one registry.

## Git Branch / Commit / PR

- Do not push directly to `main`. Work on a feature branch.
- One coherent change per commit; use a clear commit message.
- Open a PR for review. Do not merge without approval.

Commit message convention:

```text
feat(skill): add <skill-name>
update(skill): refine <skill-name>
fix(skill): fix <skill-name>
move(skill): move <skill-name>
deprecate(skill): deprecate <skill-name>
archive(skill): archive <skill-name>
feat(capability): add <capability-name>
update(capability): update <capability-name>
feat(automation): add <automation-name>
update(automation): update <automation-name>
chore(registry): update <domain> registry
feat(store): <store-level change>
docs(store): <store-level documentation>
```

Tool-generated commits are exempt from this list. `git subtree add` writes its own
message (`Add '<prefix>/' from commit '<sha>'`) and it must not be reworded — the
trailers it carries are the sync anchor (see `skills/store-publish/references/iterate.md` §0c).

## Human Approval

High-risk operations require explicit human approval:

- lifecycle promotions
- capability status changes
- moving / archiving / deleting entities
- any change affecting permissions or authentication
- any change to the dependency contract

## No Unrelated Changes

Each contribution touches exactly the files its stated goal requires.

## Domain-Specific Rules

- Contributing a **Skill** → read `skills/**` policy:
  `skills/LIFECYCLE.md`, `skills/ACCEPTANCE.md` (plus `SKILL-FORMAT.md` and `VERSIONING.md` at the root)
- Contributing an **External Capability** → read `external-capabilities/**` policy:
  `external-capabilities/SECURITY.md`
- Modifying **dependencies** between the two → read `dependencies/capability-map.yaml`

## Safety Rules

Do not:

- create duplicate skills or capabilities without checking the registry
- mix unrelated capabilities into one skill or record
- store secrets, tokens, passwords, or credentials
- claim permissions that have not been verified
- change unrelated files
- invent project ownership, provider, or lifecycle status when it is unknown

When required information is missing, stop and ask for clarification instead of guessing.
