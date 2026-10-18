#!/usr/bin/env python3
"""Tracked-file hygiene — generated files must never enter the Store.

`scripts/validate_store.py` is deliberately pure-filesystem: no git, no
subprocess, so a tarball or a shallow checkout still validates. That property is
worth keeping, which is why "is this file tracked?" lives in its own tool.

Why this exists. `external-capabilities/mcp/investdesk-ideas` committed its
`node_modules/`: 671 files, 74% of everything tracked in the repository. Every
asset was registered, every tag agreed with its registry, the validator reported
a clean run — and nothing was asking this question. The cost is not disk (it
compressed well); it is that three quarters of the file list became someone
else's source, so grepping, walking and reviewing all drown.

Forbidden anywhere in the tracked tree:
    node_modules/   __pycache__/   .venv/   dist-test/
    .DS_Store   *.pyc   *.pyo   *.tgz   *.env

`dist/` is NOT forbidden. For a published capability the compiled output is what
a consumer installs, and the Store hosts the runnable artifact — that is a
deliberate difference from an application repository.

Usage:
    python3 scripts/check_tracked_hygiene.py

Exit codes:
    0   clean
    1   at least one generated file is tracked
    2   not a git repository / git unavailable
"""

import subprocess
import sys

# Substrings: a tracked path containing any of these should not exist.
FORBIDDEN_SUBSTRINGS = (
    "/node_modules/",
    "/__pycache__/",
    "/.venv/",
    "/dist-test/",
)

# Basenames: exact matches.
FORBIDDEN_BASENAMES = {
    ".DS_Store",
    ".env",
}

# Suffixes.
FORBIDDEN_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".tgz",
)


def tracked_files():
    try:
        proc = subprocess.run(
            ["git", "ls-files", "-z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError as exc:  # pragma: no cover - git missing
        sys.stderr.write(f"could not run git: {exc}\n")
        sys.exit(2)
    if proc.returncode != 0:
        sys.stderr.write(
            "could not list tracked files — is this a git checkout?\n"
            f"{proc.stderr.strip()}\n"
        )
        sys.exit(2)
    return [p for p in proc.stdout.split("\0") if p]


def offences(path: str):
    reasons = []
    lowered = "/" + path
    for needle in FORBIDDEN_SUBSTRINGS:
        if needle in lowered:
            reasons.append(f"contains {needle.strip('/')}/")
    name = path.rsplit("/", 1)[-1]
    if name in FORBIDDEN_BASENAMES:
        reasons.append(f"basename {name}")
    for suffix in FORBIDDEN_SUFFIXES:
        if name.endswith(suffix):
            reasons.append(f"suffix {suffix}")
    return reasons


def main() -> int:
    files = tracked_files()
    bad = []
    for path in files:
        reasons = offences(path)
        if reasons:
            bad.append((path, reasons))

    print(f"scanned {len(files)} tracked file(s)")
    if not bad:
        print("no generated files are tracked")
        return 0

    print()
    for path, reasons in bad:
        print(f"  FAIL {path}  ({', '.join(reasons)})")
    print(f"\n{len(bad)} tracked file(s) should not be in the repository")
    print("  fix: git rm -r --cached <path>  and add the pattern to .gitignore")
    return 1


if __name__ == "__main__":
    sys.exit(main())
