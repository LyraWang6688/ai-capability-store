# External Capability Security Policy

## Rule: No Credential Storage

This repository MUST NOT store, in any file, commit message, or history:

- API keys
- tokens
- cookies
- passwords
- client secrets
- private credentials
- any secret value

## Allowed: Authentication Metadata

A capability record MAY register:

- auth type (e.g. oauth2, api-key, none)
- required scopes
- permission description
- secret reference name (a label pointing to a secret stored elsewhere)

A secret reference name is a label, not the secret value.

## Core Distinction

```text
Authentication Metadata  ≠  Credential Storage
```

- **Authentication Metadata** describes HOW authentication works and WHAT permissions are needed.
- **Credential Storage** holds the actual secret material — NEVER allowed here.

## Remote-Triggered Execution

Some capabilities move work across a trust boundary. There are two directions and
they carry different risks, so the requirements differ.

| Direction | What happens | In this Store |
|---|---|---|
| **Inbound** | a remote party causes work on the operator's machine | `cli/dsh-feishu-remote` |
| **Outbound** | local content leaves the machine | `plugin/selection-toolbar`, `cli/ai-quote-clip` |

### Inbound — a remote message must not be able to widen the trust boundary

A capability that executes something because a message arrived is the highest-risk
shape in this repository. It must satisfy all of the following **before** it is
registered:

| # | Requirement | Why it is not optional |
|---|---|---|
| 1 | **Sender allowlist, fail-closed** | An empty allowlist must refuse to start, not allow everyone. `dsh-feishu-remote` throws when `allowedOpenIds` is empty (`src/config.mjs`) — that is the standard. |
| 2 | **The remote text never becomes a shell string** | It goes in as an argv element or on stdin. `spawn(cmd, args)` with `args` containing the message, never `exec("cmd " + message)`. `shell: true` is a finding, not a style choice. |
| 3 | **Chat scope is declared** | "p2p only" is a security statement. A group chat makes the sender someone else's problem. |
| 4 | **High-risk actions need a second, explicit confirmation** | A keyword match is a *filter*, not an authorization. The confirmation must come from the operator, in a channel the remote party does not control. |
| 5 | **Append-only local audit** | After an incident, "what ran, when, triggered by whom" must be answerable without reconstructing it from logs. |
| 6 | **Bounded execution** | A timeout, and termination that escalates — SIGTERM then SIGKILL. A remote message must not be able to occupy the machine indefinitely. |
| 7 | **Null result on missing configuration** | If the operator has not configured a destination or a credential, the capability reports that and does nothing. It must not fall back to a default that happens to run. |

**State who enforces the boundary.** A wrapper's job is to make the remote input
*narrow* — one sender, one chat type, one confirmation. It is usually **not** the
last line of defence: `dsh-feishu-remote` ends by handing the text to an agent, and
what that agent may then do is the agent's policy, not the wrapper's. If the record
does not say where the boundary actually sits, every reader will assume it sits
somewhere else.

### Outbound — local content leaving the machine

| # | Requirement |
|---|---|
| 1 | **Destination declared** in `auth` / `compatibility`, not discovered at runtime |
| 2 | **What leaves stated plainly** — selected text, file contents, the whole conversation. "It writes to Feishu" is not a description. |
| 3 | **The operator owns the destination** — a token or document target lives in the operator's own config (outside the repository, 0600), never in the Store |
| 4 | **A local copy is not a backup** — an offline copy in localStorage or a log is convenience, not a durability guarantee, and must be described as such |

Both directions remain governed by ** § No Credential Storage** above. Inbound
capabilities are where that rule matters most: a credential that reaches a remote
message has already left.

## Responsibilities

- Never commit a secret in code, config, registry, docs, commit message, or history.
- When a secret is detected, remove it and rotate the secret; do not just delete the file.
- Do not claim permissions that have not been verified.
- When in doubt, register metadata only and store the actual secret in a dedicated secret manager.
