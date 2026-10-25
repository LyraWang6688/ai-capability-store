# COMMERCE.md — Asset Commerce Protocol

Every asset in this Store answers three questions, and answers them **in the
registry**, not in a conversation:

| # | Question | Field | Where |
|---|---|---|---|
| 1 | Is it sold at all? | `charge` | skill · capability · automation |
| 2 | If so, how is it charged? | `model` | same record |
| 3 | What is the user actually paying for? | `value` | same record |
| — | What enforces the payment? | `carrier` | **capability only** |

This file is a **decision contract**, not a price list. Prices change with the
market and with the campaign; they do not belong in a repository. What belongs
here is the durable part: whether an asset is commercial, what it bills through,
and what the buyer is buying.

> Reading order: [`AGENTS.md`](./AGENTS.md) → [`CONTRIBUTING_AI.md`](./CONTRIBUTING_AI.md)
> → [`PUBLISHING.md`](./PUBLISHING.md) (does it enter the Store?) →
> **this file** (is it sold?) → [`VERSIONING.md`](./VERSIONING.md).

**Entering the Store, publishing to a channel, and charging money are three
separate decisions.** `PUBLISHING.md` governs the first two. This file governs
the third. Being in the Store says nothing about being sold; being sold says
nothing about being published.

---

## 1. The schema

```yaml
# free — one line, nothing else
commerce: {charge: free}

# paid
commerce:
  charge: paid
  model: subscription        # oneoff | subscription | enterprise
  carrier: self-api          # license | self-api | hosted  — capability only
  value: "…"                 # one sentence: what the user pays for
```

### The shape is decided by `charge`, not by which fields exist

A free record carries **`charge` only**. A paid record carries `model` +
`value`, plus `carrier` on a capability. `charge: free` next to
`model: subscription` answers the same question twice and leaves the next
reader unable to tell which answer to trust. The validator rejects both
directions of that contradiction, so there is no "mostly free" record.

### `carrier` lives on the capability, never on the skill

`hosting` says where the **code** is; `carrier` says where the **gate** is.
Both are facts about a runnable thing, and a Skill is not runnable — it is
instructions. A Skill's gate is therefore **derived** from its dependencies:

```
paid Skill  ⇒  requires (required: true) a capability that is itself paid
               AND carries a carrier
```

Writing `carrier` on the Skill as well would maintain the same fact twice.
`required: false` does not count — an optional gate is a bypassable gate, so it
cannot be what the user is paying for.

### Automations are always free

An Automation is triggered by a clock on somebody's machine or CI; it is not an
artifact a consumer installs (`PUBLISHING.md` §D). "Sell the Automation" is
therefore a domain error, not a pricing choice. What gets sold is the service it
calls — and that is a Capability.

---

## 2. The decision: two axes, four quadrants

Do not rank assets by how much work they took. Rank them by two properties a
buyer can feel:

- **axis 1 — copy cost**: how long would a motivated user need to reproduce it?
- **axis 2 — continuing value**: does it still matter in three months, and does
  keeping it correct cost us something?

| | continuing value low | continuing value high |
|---|---|---|
| **copy cost low** (text, SOP, one-off script) | **free** — charging only damages trust; anyone can rewrite it and owe you nothing | **free + subscription** — you sell *the update*, not the file |
| **copy cost high** (backend, data, login state, fixed IP) | **oneoff** — a tool; sell it and the maintenance cost is low | **subscription** — recurring cost, and no substitute |

Three vetoes. If any is true, the answer to question 1 is `free`:

1. The capability can be reproduced with "a paragraph of text + tools the user
   already has".
2. The user cannot verify within five minutes that it works. Unverifiable value
   does not get paid for.
3. The asset's job is distribution or reputation (a free entry point).

---

## 3. `carrier` — the only thing that makes "paid" enforceable

Four levels, and the strength comes from **whether a server is involved**, not
from how much effort went into protection:

| carrier | What it is | Survives what | Cost to us |
|---|---|---|---|
| *(none — `charge: free`)* | nothing is enforced | — | — |
| `license` | local key check in shipped code | casual resale; **not** a determined fork | near zero |
| `self-api` | client is a thin shell; rules run behind an endpoint | copying the artifact — the copier still needs a token | a service to run |
| `hosted` | the user never installs anything; we run it | everything | availability + ops + liability |

Two things this table is deliberately ruling out:

**A hidden endpoint is not a carrier.** A URL is visible in network traces,
proxy logs and Certificate Transparency the moment it serves TLS; it cannot be
rotated without breaking every existing user, and it cannot be revoked when it
leaks. Hiding an endpoint gives you none of what a token gives you: revocation,
metering, and the ability to see who is sharing. **Publish the endpoint; gate
the rules.** What protects you is that the request shows *what was called and
what came back* — never *how it was computed*.

**Text cannot be protected at all.** The Agent Skills specification says the
agent loads the whole `SKILL.md` when the skill activates. A paid Skill's body
is therefore public by construction. This is why the model above puts the value
behind a carrier instead of inside the markdown — and why a `paid` Skill without
a gated dependency is a validation failure rather than a judgement call.

---

## 4. `model` — three shapes

| model | Shape | Fits |
|---|---|---|
| `oneoff` | buy once, includes a bounded update window | a tool whose rules do not drift |
| `subscription` | per year (or per month), renews | anything whose correctness depends on external platforms changing |
| `enterprise` | private deployment / white-label / SLA; not sold retail | buyers who need an invoice, a contract and an audit trail |

`enterprise` is here because it is a different **delivery**, not merely a higher
price: the same asset, delivered with a contract. That is the one shape in which
a buyer pays for responsibility rather than for capability.

---

## 5. Current state — the registry is the fact

Authoritative source is the three domain registries. Anything in this section is
a **restatement**; if they disagree, the registry wins.

As of 2026-10-25, of 36 registered assets, **2 Skills and 2 Capabilities are
`paid`** — and all four are the same arrangement seen from both ends:

```
readloop                      (skill, paid)  → readloop-service          (capability, paid, self-api)
teaming-meeting-analysis      (skill, paid)  → meeting-analysis-service  (capability, paid, self-api)
```

That is not a plan, it is what is already true: both services have been running
with an activation-code → host-token → `402 on expiry` flow. **Everything else
is `free`.** The audit finding behind these numbers — "41 assets, only 2 have any
authorisation mechanism" — is now a queryable fact instead of a memory.

Query it directly:

```bash
python3 - <<'PY'
import yaml, glob
for p in ["skills/registry.yaml", "external-capabilities/registry.yaml",
          "automations/registry.yaml"]:
    doc = yaml.safe_load(open(p, encoding="utf-8"))
    for section in ("skills", "capabilities", "automations"):
        for key, rec in (doc.get(section) or {}).items():
            c = rec.get("commerce") or {}
            if c.get("charge") == "paid":
                print(f"{section:13} {key:26} {c.get('model','')} {c.get('carrier','')}")
PY
```

### 5.1 Candidates — **not facts, and not approval**

The table below is a **decision queue**, not a record. Nothing here is true until
the registry says so, and moving any row into the registry is a human-approved
change (see §6). It exists because the interesting question is not "what is
charged today" but "which of the free ones could carry their own cost, and what
would have to exist first".

| Asset | Today | Candidate | What must exist first |
|---|---|---|---|
| `geo-content` | free | `subscription` | a review-rules service — its real value is `references/review-rules.md`, and platform rules change; that is a capability that does not exist yet |
| `wechat-html-css-layout` | free | `oneoff` | shares a rendering service with `animated-chart-gif`; layout rules change with the platform |
| `animated-chart-gif` | free | `oneoff` | same rendering service (CJK font + deterministic render are the cost) |
| `wechat-draft-mcp` | free | `hosted` | **cannot be `license`**: publishing requires the caller's egress IP on the WeChat allowlist, so a user's home IP breaks on every network change. It can only be run by us |
| `beijing-theater-calendar` | free | `subscription` | hard-coupled to the author's own Base today (see the sellability audit); decouple to a user-owned template first |
| `dsh-feishu-remote` | free | `enterprise` | 6 setup steps; per-seat pricing cannot cover the support cost, so retail is not an option — only private deployment with a contract |
| `readloop` · `teaming-meeting-analysis` | `paid` | *(keep)* | already correct — do not re-litigate |
| everything else | free | *(keep)* | free entry points are distribution, not lost revenue |

Two rows deserve the emphasis: `wechat-draft-mcp` is the clearest case where the
carrier is forced by the platform rather than chosen by us, and
`dsh-feishu-remote` is the clearest case where a correct asset is still not
sellable at a retail price — its support cost exceeds a subscription.

---

## 6. Changing the answer: `free` → `paid`

The order is not negotiable, and it is enforced:

1. **Build the carrier first.** A Capability must exist with `charge: paid` and
   a `carrier` that agrees with its `hosting` — `license` needs
   `hosting: store-managed` (the check runs in the user's code), `self-api` /
   `hosted` need `hosting: external` (there is an endpoint to gate).
2. **Declare the dependency**, with `required: true`, in
   `dependencies/capability-map.yaml`.
3. **Then flip the Skill** to `charge: paid` and write `value`.

Doing step 3 first fails validation — by design. "We intend to charge for this"
and "this record can charge" must not look the same in a registry.

Going the other way (`paid` → `free`) requires no ceremony and no carrier: it only
ever removes a claim.

### Human approval

Changing any `commerce` block is a commercial decision, not a maintenance edit.
It is in the high-risk list in `CONTRIBUTING_AI.md` alongside lifecycle and
permission changes.

---

## 7. Anti-patterns

| Anti-pattern | Why it fails |
|---|---|
| Selling a `.md` file | the host loads it in full; the buyer already has it |
| "The endpoint is secret" | visible in TLS metadata; leaks once and is permanent |
| Local `if (code === …)` only | one fork removes it, and you shipped the logic |
| `paid` with no carrier | nothing to revoke, nothing to meter, nothing to renew |
| Optional dependency as the gate | optional is bypassable; it is not what anyone pays for |
| Marking an Automation paid | it is not installable; the product is the service |
| Charging the free entry point | you would be taxing your own distribution |
| Pricing by how long it took to build | the buyer pays for what they avoid, not for your hours |

---

## 8. What the validator enforces

`python3 scripts/validate_store.py` — commerce is check 13 in the header list:

- every asset declares `commerce` with a legal `charge`;
- a free record carries nothing else, a paid record carries `model` + `value`
  (`value` ≥ 10 characters, so "收费" cannot stand in for an answer);
- `carrier` appears only on capabilities, and agrees with `hosting`;
- automations are rejected if marked paid;
- a paid Skill must bill through a `required: true` capability that is itself
  paid and gated.

Each of those rules has a fixture in `scripts/test_validator.py` that proves it
**fires** on the input it is meant to reject — including the cross-domain join.
A validator that only ever runs against a clean repository proves nothing about
whether a rule would catch anything.
