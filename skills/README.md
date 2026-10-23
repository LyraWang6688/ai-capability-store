# Skill Domain — Skills

**Domain: Skills = How to do**

A Skill is a reusable procedure / workflow / capability logic owned by the Store.
It defines HOW the Agent should execute a task.

## Core Model

| Layer | Meaning |
|---|---|
| Agent | Who executes |
| Skill | How to execute |
| External Capability | What to execute with |

Skills and External Capabilities are **peer Domains**. A Plugin / MCP / Connector is NOT a sub-entity of a Skill.

## Placement

**Flat layout — every skill lives at `skills/<skill-name>/` (exactly one level):**

- `skills/<skill-name>/`

**Why flat and not `skills/shared/<name>/` + `skills/projects/<project>/<name>/`:**

Agent Plugins v1 §7.1 fixes skill discovery at `skills/`, treats each **immediate
child directory** containing `SKILL.md` as one skill, and states clients
**MUST NOT recursively search deeper descendants**. A nested layout would
therefore be invisible to conformant clients — the skill would pass Store
validation and then silently fail to install.

**So placement is a registry field, not a directory level:**

| Scope | How it is recorded |
|---|---|
| Cross-project reusable | `scope: shared` (the default) |
| Project-specific | `scope: project` + `project: <project-name>` |

<details>
<summary>Migration note (schema_version 1 → 2)</summary>

`schema_version: 1` used two registry sections (`shared:` / `projects:`) that
encoded placement in the path. That is superseded: the path is now always
`skills/<name>/`, and placement moved to the `scope` / `project` fields.
</details>

## Skill Structure

Each skill must contain at least:

```text
<skill-name>/
├── SKILL.md
└── agents/
    └── openai.yaml
```

Add these only when needed:

- `scripts/` for deterministic executable logic
- `references/` for documentation or knowledge loaded on demand
- `assets/` for templates, icons, images, or other output resources

Keep `SKILL.md` focused. Do not use it as a project knowledge dump.

## Skills kept local-only (source outside the Store)

Not every skill this operator uses belongs in the Store. A skill that is **internal
tooling rather than a distributable asset** — for example the procedure the Store
uses to publish its own assets — has its **only source outside this repository**:

```text
~/.agents/skills/store-publish/     # real directory, not a symlink into the Store
```

| | Store skill | Local-only skill |
|---|---|---|
| Source | `skills/<name>/` in this repo | `~/.agents/skills/<name>` (outside) |
| Appears in `skills/` as | a real directory | a **gitignored symlink** to the real directory |
| Registry entry | required | none |
| Lifecycle / version / tag | required | none |
| Referenced in docs as | `skills/<name>` | `~/.agents/skills/<name>` |

The only content that may point outside the Store is a **gitignored symlink**, so
the skill is visible in `skills/` without being an asset:

```text
skills/store-publish -> ../../../../.agents/skills/store-publish   # local, never committed
```

Two rules keep this honest:

- the symlink is **never committed** — a clone elsewhere would receive a dangling
  path into some other machine's home directory (`.gitignore` covers it);
- `scripts/validate_store.py` skips **symlinked** directories when discovering
  packages, so such a skill neither needs a registry entry nor counts as an asset.
  A *real* directory without a registry entry still fails — that is the signal to
  move it out of the checkout.


## Registry

`skills/registry.yaml` is the machine-readable source of truth for:

- Skill identity
- path
- lifecycle status
- version

Required fields per skill entry (when registered):

- `name`
- `path`
- `status`
- `version`
- `updated` — the date this **registry record** was last updated. For a newly
  registered skill that is the registration date. It tracks the record, not the
  skill's content (content versions are tracked by `version`); the two coincide
  from the first iteration onward and differ only when an older skill is
  registered for the first time.

Project-specific skills should also be associated with a project.

## Lifecycle

`draft -> testing -> active -> deprecated -> archived`

See [LIFECYCLE.md](./LIFECYCLE.md) for transition rules.

## Versioning

Semantic `X.Y.Z` per skill, recorded **only** in `skills/registry.yaml` —
never in `SKILL.md`. See [`../VERSIONING.md`](../VERSIONING.md).

## Acceptance

Every skill must pass the gates in [ACCEPTANCE.md](./ACCEPTANCE.md) before promotion.

## Add or Update Workflow

1. Determine whether the requested capability already exists (Reuse Scan).
2. Determine whether it is project-specific or shared.
3. Read the existing skill before changing it.
4. Make the smallest coherent change.
5. Update `skills/registry.yaml`.
6. Update the project `README.md` when project membership changes.
7. Preserve Git history; do not silently overwrite unrelated work.
8. Use a clear commit message (see `CONTRIBUTING_AI.md`).
