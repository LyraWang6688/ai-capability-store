# AI Capability Store

> 同一个 skill，在 ChatGPT 能装、在 Claude 也能装 —— 因为你有一套自己的能力仓库，而不是散落在每个 AI 客户端里。
>
> **给谁用**：同时用多个 AI Host（ChatGPT / Claude / Codex / 豆包 / DeepSeek）的人
> **它做什么**：把 Skill / MCP / CLI / Plugin 收成一份可版本化、可移植、有契约的资产，而不是一次性提示词
> **怎么开始**：`python3 scripts/validate_store.py` 自检一遍，或从 [`skills/`](./skills) 看一个真实能力

这是王颖个人长期 AI 能力资产的 **Canonical Store**：
将 AI 接入真实 Workspace，把自然语言理解转化为可靠执行，
并将与不同 AI Host 共创的 Skill、MCP、Plugin、CLI 等能力，
沉淀为可复用、可跨平台、可版本化、可持续迭代和可商业化的
个人 AI 能力资产。

## AI Hosts

Examples of AI Hosts that co-develop or use these assets:

- ChatGPT
- Codex
- Claude
- Trae
- 豆包
- DeepSeek
- etc.

**Development Host ≠ Asset Ownership.**
A Host can participate in developing or using an asset, but the canonical
source of the asset lives here:

```text
LyraWang6688/ai-capability-store
```

## Core Model

```text
Skill               = How to do
External Capability = What can be called
```

Three **peer Domains**:

| Domain | Owns | Examples |
|---|---|---|
| Skills | How to do | Method / SOP / Workflow / Decision Rule / Know-how |
| External Capabilities | What can be called | MCP / Plugin / CLI / Connector / API / Integration |
| Automations | What runs by itself | Scheduled collection / recurring aggregation / event-driven maintenance |

A Plugin is NOT a sub-entity of a Skill. Formal Domain remains
**External Capability**, which also covers plugin / mcp / connector / cli /
external-api / integration.

The Skill/Capability split is **who triggers it**: a Skill runs because an Agent
decided to, a Capability is called because something asked for it. An Automation
runs because **a clock fired** — it is execution, not capability. Automation
output is committed to the `data` branch and never to `main`, so machine data
cannot bury the Store's asset history.

## Dependency Layer

```text
Skill → Required External Capabilities
```

`dependencies/capability-map.yaml` records which External Capabilities a Skill requires.

## What the Store Governs

The Store is **not an Agent Runtime**. It does not build a custom Agent runtime,
memory, planner, tool router, server, or database — GitHub is the Store workspace.

The Store governs assets, not native protocols:

| Store Governance | Native Protocol |
|---|---|
| Placement | Skill Protocol (how a Skill describes/runs itself) |
| Identity | MCP Protocol (Client/Server interaction contract) |
| Registry | ... |
| Version | The Store does NOT redefine these protocols. |
| Dependency | Native Protocol ≠ Store Governance |
| Validation | |
| Publishing | |
| Lifecycle / Status | |
| History | |
| Distribution metadata (future) | |

## Repository Structure

```text
ai-capability-store/
├── AGENTS.md                       # Control Plane / Router for Agents
├── README.md
├── CONTRIBUTING_AI.md             # Public contribution rules
├── PUBLISHING.md                  # Asset Publishing Protocol
├── VERSIONING.md                  # Store-wide versioning contract
├── SKILL-FORMAT.md                # Asset format contract (external spec + Store additions)
├── RETIREMENT.md                  # How to retire an asset without losing the record
├── registry.yaml                  # Top-level Store Router
├── skills/                         # Domain A: Skills (how to do)
│   ├── README.md
│   ├── registry.yaml
│   ├── LIFECYCLE.md
│   ├── ACCEPTANCE.md
│   └── <skill-name>/               # flat: one directory per skill, no nesting
├── external-capabilities/          # Domain B: External Capabilities (what can be called)
│   ├── README.md
│   ├── registry.yaml
│   ├── SECURITY.md
│   ├── mcp/                        # Store-managed MCP implementations (created as needed)
│   ├── providers/
│   └── use-cases/
├── automations/                    # Domain C: Automations (what runs by itself)
│   ├── README.md
│   ├── registry.yaml
│   ├── LIFECYCLE.md
│   └── <automation-name>/          # implementation + test_*.py, one per automation
├── dependencies/
│   └── capability-map.yaml
├── tests/                          # Development / Evaluation Layer
├── templates/                      # skill-eval-case.yaml / skill-acceptance-report.md
├── requirements-dev.txt            # Dev dependencies (PyYAML)
├── scripts/validate_store.py       # Deterministic Store Validator
└── .github/workflows/validate-store.yml
```

## Placement

- Skill: `skills/<skill-name>/` (flat, always one level — see `skills/README.md`;
  cross-project vs project-specific is a registry field, not a path)
- Store-managed MCP implementation: `external-capabilities/mcp/<capability-name>/`
- Provider doc: `external-capabilities/providers/<provider-name>/README.md`

## Versioning

Semantic `X.Y.Z` per asset; registry `version` = current Store-recommended
version; immutable historical versions via namespaced Git Tags
(`<asset-name>-vX.Y.Z`). See [VERSIONING.md](./VERSIONING.md).

## Publishing

Whether an asset is published is a **Human decision**. See
[PUBLISHING.md](./PUBLISHING.md).
