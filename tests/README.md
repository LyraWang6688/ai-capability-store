# tests/ — Development / Evaluation Layer

`tests/` is the **Development / Evaluation Layer** for the Store.

- `tests/skills/` — evaluation harnesses and fixtures for the Skill Domain
- `tests/external-capabilities/` — evaluation harnesses and fixtures for the External Capability Domain
- `tests/automations/` — evaluation cases for the Automation Domain (executable tests live in `automations/<name>/test_*.py`)

## Skill Test Layout

For a skill named `<skill-name>`:

```text
tests/skills/<skill-name>/
├── cases/       # one file per case, using templates/skill-eval-case.yaml
└── reports/     # acceptance reports, using templates/skill-acceptance-report.md
```

## Contract

- Tests evaluate behavior; they do NOT define runtime skill packages.
- A skill lives under `skills/`; its tests live under `tests/skills/`.
- No fake PASS results are committed.
- The deterministic structural check is `scripts/validate_store.py` — a validator, not a quality judge.
- Its secret scan is a lightweight heuristic, NOT a full repository secret scanner.

```text
tests/
= Development / Evaluation Layer
≠ Runtime Skill Package
```
