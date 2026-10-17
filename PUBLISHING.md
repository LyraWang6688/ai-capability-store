# Asset Publishing Protocol

This file answers: when Wang Ying explicitly says "this asset goes into the Store",
what must an Agent do?

**Whether an asset is published is a Human decision.**
An Agent must NOT decide on its own that "this thing is valuable, so I will publish it."

## High-Level Flow (all asset types)

```text
Human Approval to Publish
        ↓
Read Store Rules (AGENTS.md → CONTRIBUTING_AI.md → PUBLISHING.md → VERSIONING.md
                  → registry.yaml → Domain README → Domain Policy)
        ↓
Reuse Scan (check skills/registry.yaml, external-capabilities/registry.yaml,
           automations/registry.yaml, dependencies/capability-map.yaml
           for existing entities)
        ↓
Identify Asset Type (Skill | External Capability | Automation)
        ↓
Choose Canonical Placement (see Placement rules below)
        ↓
Preserve Native Asset Structure (Skill protocol / MCP protocol are NOT rewritten)
        ↓
Normalize Store Metadata (registry entry per Domain Contract)
        ↓
Register in Domain Registry
        ↓
Declare Dependencies when applicable (dependencies/capability-map.yaml)
        ↓
Bring / Link Valid Tests and Evidence
        ↓
Secret Scan (no credential values — Authentication Metadata only)
        ↓
Store Validator (scripts/validate_store.py)
        ↓
Feature Branch → PR → CI → Review
        ↓
Human Approval
        ↓
Merge
        ↓
Tag / Release when applicable (namespaced Git Tag; Release for distributable artifacts)
```

## A. Skill Asset Publishing

1. Confirm Human approval to publish the Skill.
2. Reuse Scan against `skills/registry.yaml`.
3. Placement: always `skills/<skill-name>/` (flat — see `skills/README.md` for why).
   Cross-project vs project-specific is recorded in the registry, not the path:
   - Cross-project reusable: `scope: shared` (default)
   - Project-specific: `scope: project` + `project: <project-name>`
4. Preserve the Skill's native structure (`SKILL.md`, `agents/openai.yaml`, etc. — see `skills/README.md`).
5. Register in `skills/registry.yaml` (name / path / status / version / updated, + scope / project for project skills).
6. If the Skill depends on External Capabilities, declare them in `dependencies/capability-map.yaml`.
7. Bring or link tests/evidence (Gate 0-6 in `skills/ACCEPTANCE.md` apply to promotion, not just publication).

## B. External Capability Asset Publishing

1. Confirm Human approval to publish the External Capability.
2. Reuse Scan against `external-capabilities/registry.yaml`.
3. Placement:
   - Store-managed implementation: `external-capabilities/mcp/<capability-name>/` (for MCP; other shelves are created only when a real asset needs them)
   - Provider documentation: `external-capabilities/providers/<provider-name>/README.md`
4. Preserve the native protocol structure (e.g. a Node/Python/Go MCP keeps its own project layout — the Store only fixes where the asset root lives, not the internal source layout).
5. Register in `external-capabilities/registry.yaml`:
   - Required: name / provider / type / status / provider_path
   - Store-managed (has `implementation_path`): also requires `version` (semantic X.Y.Z)
   - Optional: auth metadata / capabilities / permissions / notes
6. Never register credential values — Authentication Metadata ≠ Credential Storage (`external-capabilities/SECURITY.md`).
7. Bring or link tests and evidence for the capability.

## C. Automation Asset Publishing

1. Confirm Human approval to publish the Automation.
2. Reuse Scan against `automations/registry.yaml`.
3. Placement: `automations/<automation-name>/` — entrypoint, tests and `README.md`
   stay together (`automations/README.md` explains why the directory is the unit).
4. **Decide the domain honestly.** An Automation is triggered by a clock or an
   event; a Capability is *called*. If a human or a model decides *when* to run
   it, it is a Skill, not an Automation (`DOMAIN_MISMATCH` — see Stop Conditions).
5. Register in `automations/registry.yaml`:
   - Required: name / path / entrypoint / status / version / updated /
     trigger_kind / workflow / output
   - `trigger_kind` is `daily` / `weekly` / `manual` / `event`
6. **Never record the cron expression in the registry.** It lives only in the
   bound workflow's `on:` block — a cron copied into two files drifts. The
   validator checks that `workflow:` exists, is bound to this directory, and
   carries a `schedule:` trigger whenever `trigger_kind` is not `manual`.
7. Output goes to the `data` branch, never to `main`. The `output` contract names
   that branch and the validator enforces it.
8. Bring tests for the entrypoint. An Automation runs unattended — nobody is
   watching the first failure, so a passing local run is the only cheap signal.
9. **Tag it like any other asset** (`VERSIONING.md` §6). Being scheduled does not
   exempt it; it is precisely the asset that most needs to be rollable back.

## Stop Conditions

- Missing required metadata → do not guess; ask Human.
- A credential value is found → stop, remove, and rotate; do not merely delete the file.
- Asset type is ambiguous → ask Human; do not mix a Workflow/SOP into the Capability Registry (DOMAIN_MISMATCH) or an External Capability into the Skill Registry.
