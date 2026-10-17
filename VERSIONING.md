# Versioning — X.Y.Z (Store Contract)

This is the **Store-wide** versioning contract for every asset (Skills, External
Capabilities and Automations). There is exactly one such file — the former
`skills/VERSIONING.md` supplement is merged here, so no duplicate rules exist.

If a new peer Domain is ever added, **add it to this sentence and to §6 in the
same change**. A contract that says "every asset" and then enumerates two of the
three domains is wrong in the direction that hides: the automations follow the
registry-and-tag discipline below, and nothing told them to.

## 0. This does not conflict with the external standards

The external standards ([agentskills.io](https://agentskills.io/specification),
[agent-plugins.org](https://agent-plugins.org/specification)) govern **what a
single asset looks like**. This file governs **how versions are managed across
the many assets in one repository** — a question those standards do not answer.

The two layers only collide in one place: writing `version` into a `SKILL.md`.
§1 settles that.

## 1. Where `version` lives (the single most important rule here)

| Location | Allowed? | Why |
|---|---|---|
| Domain registry (`skills/registry.yaml`, `external-capabilities/registry.yaml`, `automations/registry.yaml`) | ✅ **the only source of truth** | Store governance state |
| `SKILL.md` frontmatter, top level | ❌ **forbidden** | not in the external whitelist — the reference validator rejects the whole skill |
| `SKILL.md` `metadata.version` | 🟡 legal, but do not use | would duplicate the registry → two sources of truth |

**Version is recorded in the domain registry and nowhere else.**

Rationale: the ecosystem does **not** use version numbers to decide whether an
asset changed. It uses **content hashes** (see the `skills` CLI lock file) and
immutable git refs. A version number is a human-facing communication label, not
a machine contract — so it belongs to the Store's registry, not to the skill file.

## 2. Stable Machine Identifier

Every asset has one stable machine identifier, and it is also the directory name:

```text
repo-hygiene
feishu-cli-mcp-server
```

Do NOT express version through directory names. Forbidden:

```text
repo-hygiene-v1/
repo-hygiene-v2/
repo-hygiene-final/
```

The identifier must equal the parent directory name and the registry map key
(enforced by `scripts/validate_store.py`).

## 3. Canonical Path Is Stable

```text
skills/repo-hygiene/
external-capabilities/mcp/feishu-cli-mcp-server/
```

Upgrading the version does NOT change the directory. This is what keeps every
consumer's reference valid across upgrades.

## 4. Semantic Versioning

```text
MAJOR.MINOR.PATCH
```

| Segment | Increment when |
|---|---|
| PATCH | backward-compatible fix |
| MINOR | backward-compatible capability addition |
| MAJOR | breaking change / incompatible behavior |

**Lifecycle coupling** (`skills` domain only):

```text
0.x.x   experimental / draft / testing
1.x.x+  active and stable enough for normal use
```

A skill whose `status` is `active` MUST have `major >= 1`
(enforced by `scripts/validate_store.py`).

## 5. Registry `version` = Current Store-Recommended Version

`version` in a domain registry means: **the version the Store currently
recommends for use** — the default for consumers.

It is **not** "the newest version that exists". They differ when a newer version
is still experimental, or a recent one has a regression. `main` holds the
current maintained state; its registries describe the recommended versions.

## 6. Immutable Historical Versions = Namespaced Git Tags

**Every registered asset — Skill, External Capability, or Automation — gets a
namespaced tag for every version it publishes.** Being a peer Domain means taking
on the same version discipline; the domain does not exempt an asset.

```text
<asset-name>-vX.Y.Z
```

Examples:

```text
repo-hygiene-v0.1.0
feishu-cli-mcp-server-v0.1.0
github-trending-daily-v0.1.0
```

Do NOT use a monorepo-wide tag such as `v0.1.0` — multiple assets would collide.
One repository holds many assets, so every tag carries the asset name.

A tag is a permanent label on a commit. "Rolling back to `v4.6.0`" means
checking out that tag — it does **not** delete later versions; they remain in
history.

### A tag must agree with the registry at the commit it points at

Three rules that only work together:

1. **The version bump ships in the same PR as the content change.** Split them and
   no commit satisfies both "the content is vX.Y.Z" and "the registry says
   vX.Y.Z" — the tag then cannot be self-consistent wherever it is placed.
2. **Check before tagging, not after.**
   `python3 skills/store-publish/scripts/check_tag_version.py <asset> <version>`
   verifies the tag name is free, the asset is registered (in *any* domain), the
   registry at the target commit already carries this version, and the target is
   on `main`. `--audit` sweeps every existing tag.
3. **A repair PR cannot fix a wrong tag.** It repairs `main`; the commit the tag
   points at is immutable. This cost three drifted tags in October 2026 and is
   exactly why (1) and (2) exist.

If a new peer Domain is added, the check must learn it **in the same change**.
`check_tag_version.py` fails loudly on a domain it does not recognise rather than
skipping it — a checker that silently ignores the newest Domain is worse than no
checker, because it reports success for a domain it never looked at.

## 7. Consumer Version Policy

- **Default**: use the version currently recommended in the registry.
- **Reproducible builds**: pin to a specific immutable git tag.

## 8. GitHub Releases

Releases are for finished artifacts that need to be downloadable/distributable.
Do NOT force a Release for every internal experimental version.

## 9. Stable ID

Brand copy and display names may change. **Machine identifiers stay stable.**
Do NOT create a new machine asset identity because of a logo, copy, or
display-name change. Machine-ID migration is deferred until a real need exists.
