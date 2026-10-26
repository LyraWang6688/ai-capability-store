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
        ↓
[SEPARATE DECISION] Distribution via npm — only for runnable, installable assets.
                    Its own preconditions live in §D. Being in the Store does NOT
                    mean being published, and tagging does NOT publish.
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
   - Required: name / provider / type / hosting / status / provider_path / version (semantic X.Y.Z)
   - `hosting: store-managed` → also requires `implementation_path` (must exist under `external-capabilities/`)
   - `hosting: external` (service code in a separate project) → requires `endpoint` (https)
     and `contract_path` (the contract must live in this repository); `implementation_path` is forbidden
   - Optional: auth metadata / capabilities / permissions / notes
6. Never register credential values — Authentication Metadata ≠ Credential Storage (`external-capabilities/SECURITY.md`).
7. Bring or link tests and evidence for the capability.

## C. Automation Asset Publishing

1. Confirm Human approval to publish the Automation.
2. Reuse Scan against `automations/registry.yaml`.
3. Placement: `automations/<automation-name>/` — or, when the automation must
   share files with a sibling, `automations/<family>/<member>/` with the shared
   files at the family level. Entrypoint, tests and `README.md` stay together;
   `automations/README.md` § Families explains why the directory is the unit and
   what a family may and may not contain.
4. **Decide the domain honestly.** An Automation is triggered by a clock or an
   event; a Capability is *called*. If a human or a model decides *when* to run
   it, it is a Skill, not an Automation (`DOMAIN_MISMATCH` — see Stop Conditions).
5. **Choose `executor` independently of `trigger_kind`.** `trigger_kind` says how
   often (`daily` / `weekly` / `monthly` / `quarterly` / `manual` / `event`); `executor` says
   what runs it (`github-actions` / `launchd` / `systemd` / `human`). Each requires exactly
   its own descriptor and forbids the other's:
   - `github-actions` → `workflow:`
   - `launchd` → `launchd: {label, template}`, template committed under
     `automations/<name>/deploy/` (or `automations/<family>/<member>/deploy/`)
   - `human` → neither
   Do not reach for `github-actions` by default. A runner needing a credential in
   the operator's own keychain cannot run on a hosted runner; declare `launchd`
   instead of pretending otherwise.
6. Register in `automations/registry.yaml`:
   - Required: name / path / entrypoint / status / version / updated /
     trigger_kind / executor / output
7. **Never record the schedule expression in the registry.** A `github-actions`
   cron lives only in its workflow's `on:` block; a `launchd` schedule lives only
   in its plist template. A schedule copied into two files drifts. The validator
   checks that the descriptor exists, is bound, and carries a schedule trigger
   whenever `trigger_kind` is not `manual`.
8. Declare `output.target`:
   - `git-branch` — `branch` must be `data` plus a `path_pattern`. Machine output
     never goes to `main`.
   - `external-system` — a `destination` naming the outside system. The validator
     can only record that claim; it cannot verify an external write.
9. Bring tests for the entrypoint. An Automation runs unattended — nobody is
   watching the first failure, so a passing local run is the only cheap signal.
10. **Tag it like any other asset** (`VERSIONING.md` §6). Being scheduled does not
   exempt it; it is precisely the asset that most needs to be rollable back.

## D. Distribution — npm (and Releases)

**Entering the Store is not distribution.** §A–§C describe how an asset becomes
governed. This section describes how it reaches a machine that is not this repo.
They are separate decisions with separate preconditions, and the second one can
break things the first one cannot.

### Which assets may go to npm

Only assets a consumer can actually **run on their own machine**:

| Shape | npm? | Why |
|---|---|---|
| stdio MCP / CLI | yes | `npx <package>` is the point of publishing it |
| DSH plugin (Cordis bundle installed into a Harness profile) | yes | the consumer installs it into their own Harness profile and it runs locally; `plugin_manager` `install_bundle` accepts the package name |
| HTTP / hosted service | **no** | it needs a deployment, not an install; npm only distributes its configuration — including whatever that configuration names |
| Automation | no | triggered on someone's machine or CI, not installed by a consumer |

A DSH plugin has no `bin` and normally no build step, so preconditions 3 and 4
below do not apply to that row; preconditions 1, 2, 5 and 6 do.

A hosted service published "for completeness" is worse than unpublished: every
consumer installs something that cannot start, and the package leaks the shape of
the deployment.

> `feishu-cli-mcp-server` is the current example of the **no** row. It is an HTTP
> server (nginx + pm2 + OAuth), has no `bin`, and its `deploy/` directory holds
> production infrastructure identifiers. It is deliberately **not** published; its
> registry `notes` say so.

### Preconditions — all six, before `npm publish`

```text
1. `files` whitelist          Without it npm publishes everything not gitignored:
                              deploy/, .agents/, .github/, .env.example. This is the
                              one that leaks rather than merely embarrasses.
2. `license` and `repository` npm surfaces both; a missing repository is an
                              invisible broken link on the package page.
3. build artifacts exist      `dist/` must be produced. A `prepare` script that runs
                              `build` is the reliable way — it cannot be forgotten.
4. `bin` points at runnable JS
                              A `.ts` bin only runs where Node's type stripping is on
                              by default (>=22.18 / >=23.6). Ship compiled JS or raise
                              `engines` to match.
5. `npm pack --dry-run` reviewed by eye
                              The last cheap moment to notice a leak.
6. published version == registry version
```

Preconditions 1–5 are checked locally; 6 is checked after the fact:

Precondition 1 has a second half that PR CI now enforces. Every tracked file in a
package must be either inside the `files` whitelist (it ships) or named in
`scripts/package-files/allow.yaml` (it deliberately does not ship). Without that,
"we forgot to add it" and "we decided it is development-only" look identical —
until a consumer installs a package that is silently missing part of itself.
`python3 scripts/check_package_files.py` compares `npm pack --dry-run` against
`git ls-files`; a new file that is neither shipped nor allowlisted fails the build.

```bash
npm view <package> version
# must equal external-capabilities/registry.yaml → capabilities.<package>.version
```

### The published version must equal the registry version

These drift for the same reason tags drifted (`VERSIONING.md` §6): the registry
bump and the publish happen at different times, so a version can exist on npm that
git never labelled, or a tag can exist for a version never published.

**Publish from the commit you tagged.** Then the tag, the registry and npm all name
the same thing, and "pin to X.Y.Z" is true whichever of the three a consumer uses.

### What distribution is NOT

- It does **not** change `status`. A published asset can still be `limited`; npm
  says it is downloadable, not that it is ready.
- It does **not** replace the tag. The tag is the immutable history; npm is a
  delivery channel and allows re-publishing.
- It does **not** imply the Store recommends that version — the registry does that
  (`VERSIONING.md` §5).

## Stop Conditions

- Missing required metadata → do not guess; ask Human.
- A credential value is found → stop, remove, and rotate; do not merely delete the file.
- Asset type is ambiguous → ask Human; do not mix a Workflow/SOP into the Capability Registry (DOMAIN_MISMATCH) or an External Capability into the Skill Registry.
