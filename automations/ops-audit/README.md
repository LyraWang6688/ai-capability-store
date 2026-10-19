# ops-audit

Monthly, **read-only** audit of the owner's Linux server: resource pressure, service
liveness, TLS certificates, and whether the projects actually deployed on that server
still map to GitHub repositories that exist and are active.

Output is a **single-file HTML report** (inline CSS, no external assets) plus a JSON
twin and a snapshot for month-over-month comparison.

## Why this is an Automation, not a Skill or a Capability

The trigger decides the domain: **a clock fires it** (`systemd` timer, monthly).
Nobody calls it, and no model decides "now is the time". See the Automation Domain
contract for `executor: systemd` and `output.target: local-file`.

## What it does NOT do

- **Never mutates anything.** No restarts, no config edits, no file writes outside its
  own report directory.
- **Never deletes a project.** When a deployed project's upstream repo is archived or
  gone it emits a *retirement recommendation* marked "needs human confirmation".
  Repository state ≠ business state: an archived repo may still back a live service.
- **Does not write documentation.** It reports facts and deltas; turning them into
  prose is an Agent's job.

## Inputs

`config.json` next to the entrypoint (**not** committed; the deployed copy is `chmod 600`):

```jsonc
{
  "runtime": { "local": true },                  // true = run on the target machine
  "server": {
    "host": "…", "ssh_user": "ubuntu", "roots": ["~", "/opt"],
    "exclude": ["/srv/source-checkouts"]      // 部署用的源码检出，不算部署项目
  },
  "domains": { "web": "web.example.com" },       // reachability targets
  "expect": { "pm2": ["my-api"], "docker": ["my-web"], "ports": [5000, 3011] },
  "repos": { "owner": "github-login", "inactive_days": 180 },
  "thresholds": { "disk_warn": 85, "disk_crit": 92, "cert_warn_days": 21 },
  "paths": { "data_dir": "/var/lib/ops-audit" }
}
```

[`config.example.json`](config.example.json) is the placeholder version.

Two collection modes: `runtime.local = true` runs the checks on the current machine
(this is how the systemd deployment works); otherwise it collects over SSH, which is
useful for auditing a remote box from a workstation.

## Output

Declared in the registry as `local-file` (retention 12, `human_access` documented there):

| Path | Content |
|---|---|
| `<data_dir>/reports/<date>.html` | single-file HTML report for a human |
| `<data_dir>/reports/<date>.json` | same content, machine-readable |
| `<data_dir>/snapshots/last.json` | baseline for next month's deltas |

Why not `git-branch`: the report contains hostnames, deploy paths and certificate
expiry — operational surface that should not be committed to a branch.
Why not `external-system`: technically possible (a Feishu Base), but it needs a second
credential set and cannot express "a monthly HTML a human opens".

## Checks and thresholds

| Check | Default |
|---|---|
| Disk | >85% 🟡 / >92% 🔴 |
| Inodes | >85% 🟡 |
| Available memory | <150 MB 🟡 |
| swap **si/so activity** | sustained ≥2 of 3 samples **and** ≥100 KB/s 🟡 (single page-in is normal) |
| Load | > CPU cores 🟡 |
| Certificate expiry | <21 days 🟡 |
| Disk growth | +5% over a month 🟡 |
| pm2 restarts | +5 over a month 🟡 (suspected crash loop) |
| pm2 / containers / local ports / domains / nginx | any failure 🔴 |

Project verdict has four tiers: `活跃` (active) / `不活跃` (no push for N days — report
only, a stable service can legitimately sit still) / `已归档` (archived) / `已删除`
(repo unreachable).

## Exit codes

`0` clean · `3` findings (declared as `SuccessExitStatus=3` in the unit — a finding is
not a system failure) · `1` collection or config failure.

## Deploy (systemd)

```bash
# on the target machine
sudo mkdir -p /opt/ops-audit /var/lib/ops-audit
sudo cp ops_audit.py /opt/ops-audit/
sudo cp config.example.json /opt/ops-audit/config.json   # then fill in real values
sudo bash deploy/install.sh
```

`deploy/ops-audit.timer` runs `OnCalendar=*-*-01 21:00:00` with `Persistent=true`, so a
machine that was off at that moment catches up on next boot.

## Tests

```bash
python3 test_ops_audit.py
```

40 offline cases: remote-output parsing, threshold classification, four-tier project
verdict, month-over-month deltas, HTML rendering. No SSH, no network — safe on any CI.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `ssh 连接失败` | key auth missing / host down | verify `ssh user@host` manually |
| `config … 未配置` | `config.json` absent or unfilled | copy `config.example.json` |
| empty certificate table | no `/etc/letsencrypt/live` on the box | normal when certbot is unused |
| empty project table | no git repos under the configured `roots` | adjust `server.roots` |
| GitHub lookups failing | API rate limit (unauthenticated: 60/h) | set `repos.token`, or audit fewer repos |

## Boundaries

1. Projects are discovered via each repo's `git remote`; a directory without one is invisible.
2. It is a **snapshot**, not monitoring — no CPU/IO time series.
3. Domain reachability is measured **from the machine running the audit**. On the
   server that means "server → itself", which is not the user's view of availability.
4. Certificate days come from certbot's directory; other ACME clients are invisible.
5. The `expect` lists (pm2 names, containers, ports) are maintenance input: when a
   deployment changes, the list must change with it.
6. `server.exclude` exists because a server also holds **source checkouts** (for
   example the Store's own clone used to deploy). They are git repositories but not
   deployed projects; without the exclusion the audit counts them as one.
