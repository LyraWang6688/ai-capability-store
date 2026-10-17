# tests/automations/ — Automation Evaluation Layer

Evaluation cases for the Automation Domain. They describe **what must hold**;
the executable checks live next to each automation as `test_*.py`.

## Layout

```text
automations/<name>/
├── test_<name>.py         # deterministic offline tests (no network) — the executable layer
└── ...

tests/automations/<name>/
└── cases/<case>.yaml      # evaluation cases — the intent layer
```

## Why both layers

- **`test_*.py`** answers *"does the code still behave?"* — fast, offline, run per PR.
- **`cases/*.yaml`** answers *"is the code still asking the right question?"* — reviewed
  when the contract changes, because a passing test suite cannot detect that the
  automation silently stopped being useful.

An automation can have green tests and still be wrong. The cases exist to make
that mismatch reviewable.

## Running

```bash
python3 automations/github-trending-daily/test_scan.py
python3 automations/github-trending-weekly/test_aggregate.py
```

Neither test touches the network or the `data` branch.

## Contract

- Tests evaluate behavior; they do NOT define runtime packages.
- No fake PASS results are committed.
- `scripts/validate_store.py` is the deterministic **structural** gate; these tests are the
  deterministic **behavioral** gate. Neither is a quality judge.
