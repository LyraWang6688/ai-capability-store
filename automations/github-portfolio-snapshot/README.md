# github-portfolio-snapshot

Takes a monthly snapshot of a GitHub account's repositories and writes it into a
Feishu Base: which repositories exist, what changed since last period, and what
each one is for. Runs on the 1st at 20:00 local time.

## Why this is an Automation, not a Skill

`PUBLISHING.md` §C.4 asks one question — *who decides when this runs?*

- A human or a model decides → **Skill**
- A clock or an event decides → **Automation**

Nothing and nobody decides here: launchd fires on the 1st at 20:00. That the
**output** is later read by a human is irrelevant — every automation's output is
read by someone. The trigger is the only criterion.

## What it does NOT do

**It never modifies a GitHub repository.** It reads GitHub state and writes rows
into its own Feishu tables. The `lifecycle_action` column it fills in
(`Keep` / `Archive` / `Delete`) is a **recommendation label**, not an action.

That boundary is deliberate: an unattended job should only do things it can never
regret. Acting on those recommendations stays with a human.

## Code vs state

| | lives in | why |
|---|---|---|
| code | this directory (Store checkout) | reviewable, versioned, tested |
| `config.json` | `$GITHUB_SNAPSHOT_HOME` (default `~/github-portfolio-snapshot`) | carries a Base token and a personal login — must not be public |
| `logs/` | same work dir | launchd stdout/stderr |

`deploy/install.sh` renders the plist so that `WorkingDirectory` points at the
work dir while `ProgramArguments` points at the store checkout.

## Requirements

| Needs | Detail |
|---|---|
| `gh` | authenticated as the account being snapshotted |
| `lark-cli` | authorized **as the user**, not as the bot |
| Python | 3.9+ standard library only |

**The bot identity is not sufficient.** Verified: the app behind `lark-cli` has
no `base:record:read` scope, and the Base is the operator's own. This is also the
reason the automation is `executor: launchd` rather than `github-actions` — a
user token lives in the operator's keychain, and a hosted runner has no keychain.

## Install

```bash
cp config.example.json ~/github-portfolio-snapshot/config.json
# fill github_login / base_token / registry_table
./deploy/install.sh                 # install the launchd job
./deploy/install.sh --run-now       # install and fire once, to prove PATH is right
./deploy/install.sh --dry-run       # render the plist, touch nothing
./deploy/uninstall.sh               # unload and remove the plist
```

The first run creates the work dir and stops with exit 78 until `config.json` is
filled — a job that silently runs with a placeholder token is worse than one that
refuses.

## Run manually

```bash
python3 snapshot.py --dry-run          # compute, print, write nothing
python3 snapshot.py --no-base          # local self-check, no Feishu at all
python3 snapshot.py --period 2026-10   # target a specific month
python3 snapshot.py --force            # overwrite an existing period
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | snapshot written |
| 1 | `SnapshotError` — a GitHub/Feishu call failed; the message says which |
| 2 | `ConfigError` — `config.json` missing a required key |
| 78 | install script only: placeholder config created, fill it and re-run |

## Failure modes

| Symptom | Cause | Check |
|---|---|---|
| `[配置错误]` with the work-dir path | config absent or unfilled | `$GITHUB_SNAPSHOT_HOME/config.json` |
| launchd job exits 1, `command not found` | launchd's PATH missed a tool | `deploy/install.sh` prints a warning when it cannot resolve node/gh/lark-cli |
| `unauthorized` from lark-cli | user token expired | `lark-cli auth status`, then `lark-cli auth login` |
| period already exists | re-run for the same month | `--force` (it writes a backup first) |

## Tests

```bash
python3 test_snapshot.py
```

Offline only: config resolution, required-key validation, pure helpers, and the
report/diff logic. Nothing here touches GitHub or Feishu — those need credentials
a test run must not have.
