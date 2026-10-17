# github-portfolio-snapshot

Takes a monthly snapshot of a GitHub account's repositories and writes it into a
Feishu Base: which repositories exist, what changed since last period, and what
each one is for. Runs on the 1st at 20:17 Asia/Shanghai via GitHub Actions.

## Why this is an Automation, not a Skill

`PUBLISHING.md` §C.4 asks one question — *who decides when this runs?*

- A human or a model decides → **Skill**
- A clock or an event decides → **Automation**

Nothing and nobody decides here: the workflow cron fires on the 1st at 20:17. That the
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
| `config.json` | `$GITHUB_SNAPSHOT_HOME` (default `~/.automation-state/github-portfolio-snapshot/`) | carries a Base token and a personal login — must not be public |
| `logs/` | same work dir | launchd stdout/stderr (legacy local executor only) |

In CI there is no persistent state: the workflow materializes `config.json` from
the `SNAPSHOT_CONFIG_JSON` secret into `$RUNNER_TEMP` and sets
`GITHUB_SNAPSHOT_HOME` to point at it.

## Requirements

| Needs | Detail |
|---|---|
| `gh` | in CI it uses the job-scoped `GITHUB_TOKEN`; locally `gh auth login` |
| Feishu app | a **dedicated** app with 6 base scopes — see below |
| Python | 3.9+ standard library only (no `lark-cli`, no pip packages) |

The automation talks to the Feishu OpenAPI directly with a `tenant_access_token`,
so it needs no `lark-cli` and no operator keychain. That is what makes it
runnable on a hosted runner.

### The Feishu app

`0.2.0` moved off `lark-cli` because the only identity available to it was the
**user** token, which lives in the operator's keychain — a hosted runner has no
keychain, and `--as bot` failed with `app_scope_not_applied` (`99991672`).

Set up a dedicated app (do not reuse the operator's own CLI app):

1. Grant these 6 scopes — writes included, since the job creates records and
   may add missing fields:

   | Scope | Used for |
   |---|---|
   | `base:block:read` | listing the tables in the Base |
   | `base:record:read` | reading last period's rows |
   | `base:record:create` | writing this period's rows |
   | `base:record:delete` | pruning rows inside the retention window |
   | `base:field:read` | comparing existing columns |
   | `base:field:create` | adding a column a newer version introduced |

2. **Publish an app version.** Scopes granted but not published have no effect.
3. **Add the app as an editor of the Base.** Scopes alone do not grant access to
   a Base the app was never added to.

Credentials: `app_id` is not a secret and may live in `config.json`; `app_secret`
is read **only** from `FEISHU_APP_SECRET` and must never be written to a file or
the repository.

## Install

### GitHub Actions (current executor)

Set three repository secrets:

| Secret | Value |
|---|---|
| `FEISHU_APP_ID` | the dedicated Feishu app's `app_id` |
| `FEISHU_APP_SECRET` | that app's secret |
| `SNAPSHOT_GH_TOKEN` | a **PAT owned by the operator** — see the warning below |
| `SNAPSHOT_CONFIG_JSON` | the contents of `config.json` (start from `config.example.json`) |

> **`SNAPSHOT_GH_TOKEN` must not be `secrets.GITHUB_TOKEN`.** The snapshot walks
> the *token owner's* repositories (GraphQL `viewer`), so the job-scoped bot token
> would snapshot `github-actions[bot]`'s single repository instead of the
> operator's account. `fetch_repos()` now aborts on that mismatch rather than
> writing wrong data, but the real fix is a PAT. It needs `repo` (private
> repositories) and `read:org` (organization membership).

Then trigger `.github/workflows/automation-github-portfolio-snapshot.yml` via
**Run workflow**. The dispatch form has two switches:

- `dry-run` (default **on**) — reads GitHub and Feishu, resolves tables, writes
  nothing. Use this for the first run.
- `no-base` — skips Feishu completely; a pure GitHub self-check that needs no
  scopes at all.

### launchd (legacy local executor)

Still present under `deploy/` as a manual fallback, but `registry.yaml` no longer
points at it. To use it locally a **user**-identity `lark-cli` session is required
and the code must be told to use it — the shipped default is the app identity.

```bash
mkdir -p ~/.automation-state/github-portfolio-snapshot
cp config.example.json ~/.automation-state/github-portfolio-snapshot/config.json
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
