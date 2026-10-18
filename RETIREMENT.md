# RETIREMENT.md — Retiring an Asset

An asset that stops being useful is not an exception; it is the normal end of a
long-lived thing. This file says how to end one **without destroying the record of
what it was** — because in a Store built around long-term assets, the second half is
the hard half.

Retirement is the one operation where the repository gets smaller. Everything else
in this Store adds.

---

## 0. "Retire" is three different decisions

Most of the damage in this area comes from treating them as one.

| The decision | What actually changes | Reversible |
|---|---|---|
| **Stop recommending it** | status → `archived` | **yes** — nothing is destroyed |
| **Stop shipping it** | registry entry removed, directory deleted | only through git history |
| **Stop it existing anywhere** | `npm unpublish` | **no** |

They are taken at different times, by different reasoning, and must never be taken
in the same breath. The first one is a statement of intent. The second is a
decision to stop paying maintenance. The third is a decision made on behalf of
everyone who may already have installed it.

**Default to the cheapest one first.** Archiving costs one line and can be undone.
Deleting costs the reader who later wonders "where did that come from?". Unpublish
costs someone else's build.

---

## 1. The ladder

```text
        ┌──────────────────────────────────────────────────────────┐
        │  1. archived        status only                          │
        │     registry entry   stays                               │
        │     directory        stays                               │
        │     tag              stays                               │
        │     npm package      `npm deprecate` (still installable) │
        └───────────────────────────┬──────────────────────────────┘
                                    │  separate decision, later
        ┌───────────────────────────▼──────────────────────────────┐
        │  2. removed         registry entry gone, directory gone   │
        │     tag              STAYS (the only surviving proof)     │
        │     git history      STAYS (the code is still reachable)  │
        │     npm package      `npm unpublish` (tombstone remains)  │
        └──────────────────────────────────────────────────────────┘
```

Step 1 is reversible by editing one word. Step 2 is not — but it is not
*destruction* either: the tag still resolves, and `git checkout <tag>` still returns
the full tree.

---

## 2. What retirement never destroys

Three things survive every retirement, by construction:

**The tag.** Tags are immutable (`VERSIONING.md` §6). A tag on a commit where the
asset still existed is the only remaining answer to "what did this look like?".
**Tag before you delete**, always — after the directory is gone the tag is the only
place the answer lives.

**The git history.** A deleted directory is still in every commit that contained
it. Deleting removes it from the *current tree*, not from the *record*. Say this
out loud when someone is uneasy about deleting — the honest reassurance is "it is
recoverable", not "we kept a copy somewhere".

**The reason.** Written down, in `notes` and in the commit message. An asset that
disappears with no stated reason is indistinguishable from one deleted by mistake,
and the next person will spend the time you were trying to save.

---

## 3. Before you retire: three checks

### 3.1 Does anything depend on it?

```bash
grep -rn "<asset-name>" --include="*.yaml" --include="*.md" --include="*.ts" --include="*.js" .
```

Look past the registry. The 2026-10-18 retirement found five reference sites nobody
had listed:

```text
automations/registry.yaml      "与 MCP 共用 sync_prices" 的过时说法
skills/registry.yaml           "有 investdesk-ideas MCP 时直接写表"
skills/…/SKILL.md              沉淀步骤里的那一步
automations/…/wind.ts          clientInfo 里写着旧包名
external-capabilities/README  拿它当 shelf 的例子
```

**None of these break the validator.** They are the cost of not looking.

For an automation, `automations/LIFECYCLE.md` has a hard rule: an automation whose
output another automation consumes **must not** be archived while the consumer is
`active` or `testing`.

### 3.2 Is it tagged?

```bash
python3 skills/store-publish/scripts/check_tag_version.py --missing
```

Retire only what has a tag. If the registered version has no tag, create it first —
otherwise you are about to delete the last version of something without ever having
named it.

### 3.3 Is it published?

```bash
npm view <package> version
```

A published package outlives the directory it was built from. Retirement is not
finished until that is decided — see §5.

---

## 4. Per-Domain

Status words differ by Domain on purpose; the ladder above is the same.

| Domain | Retirement states | Transition |
|---|---|---|
| Skills | `deprecated` → `archived` | `skills/LIFECYCLE.md` |
| External Capabilities | `disabled` → `archived` | `external-capabilities/README.md` § Status Values |
| Automations | `deprecated` → `archived` | `automations/LIFECYCLE.md` |

`deprecated` (Skills, Automations) means *no longer selected, but retained for
migration*. `archived` means *maintenance has stopped*. Capabilities have no
`deprecated`: `disabled` is the "not right now" state and `archived` is the "not any
more" state.

### Automations have one extra obligation

`automations/LIFECYCLE.md`: **disable or remove the hosted workflow.** Do not leave
a scheduled workflow running against archived code. A retired automation that is
still firing once a day is worse than one that was never written — it fails
somewhere nobody is reading.

---

## 5. The npm question

`PUBLISHING.md` §D governs what may be published. This is the other direction.

| | `npm deprecate` | `npm unpublish` |
|---|---|---|
| Package still installable | **yes**, with a warning | no |
| Someone's existing install | keeps working, sees the warning | keeps working, cannot reinstall |
| Reversible | yes | **no** |
| Use when | anyone may depend on it | nobody does |

**Prefer `deprecate`.** It is the retirement-shaped action: the package answers
"this is retired" to anyone who asks, and the answer reaches people who already
installed it. `unpublish` is for the narrower case where the package was never
really consumed.

Before unpublishing, check what npm checks:

```text
published less than 72 hours ago      → full unpublish allowed
no other package depends on it        → required
fewer than 300 downloads in the past week → required
```

**What survives an unpublish is a tombstone.** The name keeps returning from the
registry with `versions: {}` and a `time.unpublished` record — bytes on the wire,
nothing installable. And the name stays **reserved**: a future asset cannot reuse
it. That is worth knowing before choosing, because "we will bring it back under the
same name" is not an option afterwards.

---

## 6. Checklist

**Archive**

- [ ] `status: archived` in the Domain registry
- [ ] `notes` says **why** and **what replaced it** — the replacement is the useful
      half for anyone who lands on the archived record later
- [ ] An automation: its workflow is disabled or removed
- [ ] A published capability: `npm deprecate <pkg>@<version> "<reason + replacement>"`

**Remove** (a separate, later decision)

- [ ] `--missing` passes — every registered version has its tag
- [ ] Dependencies checked (§3.1); an automation's consumer rule respected
- [ ] References updated — registry notes, READMEs, SKILL.md, code, domain examples
- [ ] Published: `npm unpublish` decided and executed, or explicitly deferred
- [ ] Tag kept, commit message says why, `notes` removed *with* the entry
- [ ] `validate_store.py` and `check_tag_version.py --missing` both pass afterwards

---

## 7. The case that produced this file

2026-10-18, `de0558c chore!: 退役三个 InvestDesk 遗留资产`. Three capabilities left
the Store in one afternoon because Doubao Work took over their jobs:

| Asset | Lines | Replaced by |
|---|---|---|
| `investdesk-bot` | 728 | Doubao Work as the conversation entry |
| `investdesk-ideas` | 558 | Doubao reading and writing Feishu tables directly |
| `investdesk-market` | 378 | Doubao's data plugins |

All three were **removed outright** — no `archived` stop. In each case the deciding
fact was the same: nothing in the Store consumed them, and the replacement was
already in daily use. That is a legitimate reason to skip step 1.

A fourth asset is worth contrasting: `investdesk-quotes` was **not retired**. Its
code moved *into* the automation that used it (`a8d3bbc`), because the MCP shape
existed to serve a bot that no longer existed. Retiring the wrapper and keeping the
capability is a different, better outcome than deleting both — check for it before
reaching for the delete key.

Two npm packages were unpublished (3 and 6 versions). Both tombstones remain.

The lesson that cost the most was §3.1: five reference sites, none of which the
validator could see.

---

## 8. What this document does not fix

Retirement is cleanup, not prevention. All three InvestDesk assets above were
registered and retired **within twenty-four hours** — one of them lived under two.
A process for ending an asset quickly is a process for accepting that many will end
quickly.

If that is the problem you have, this is the wrong file. The question is admission —
what earns a place in the Store at all — and the useful lever there is the `draft`
state plus a soak period, not a better funeral.
