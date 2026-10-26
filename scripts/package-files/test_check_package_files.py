#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fixture tests for scripts/check_package_files.py.

Why this exists. A gate that never fires is indistinguishable from a gate that
passes. The real repository is clean by definition, so running the checker
against it proves no check misfires — it says nothing about whether the check
would catch the thing it exists to catch.

Each case below builds a throwaway git repository with one package, breaks
exactly one thing, runs the checker, and asserts the exit code. Same shape as
`scripts/test_validator.py`, applied to the package-files gate.

The failure being guarded against: add a runtime file to a package, forget the
`files` whitelist, publish — users install a package that is silently missing
part of itself.

Usage:
    python3 scripts/package-files/test_check_package_files.py [-v]
"""

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHECK = os.path.join(os.path.dirname(HERE), "check_package_files.py")
VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  :: " + str(detail)))
    if not cond:
        fails.append(name)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content)


def make_repo(tmp):
    """One package with a `files` whitelist, plus a tracked file that is not in it."""
    repo = os.path.join(tmp, "repo")
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    # `prepare` fails on purpose: the gate must never execute lifecycle scripts.
    # Packing the real directory would run it (and in CI it runs against a tree
    # with no node_modules), which is why the checker copies tracked files first.
    write(
        os.path.join(repo, "pkg", "package.json"),
        '{"name":"fixture-pkg","version":"1.0.0","files":["index.js"],'
        '"scripts":{"prepare":"echo PREPARE-RAN >&2; exit 9"}}\n',
    )
    write(os.path.join(repo, "pkg", "index.js"), "// shipped\n")
    write(os.path.join(repo, "pkg", "dev", "preview.html"), "<html></html>\n")
    write(os.path.join(repo, "pkg", ".gitignore"), "node_modules/\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    return repo


def run_check(repo, allow_path):
    proc = subprocess.run(
        [sys.executable, CHECK, "--root", repo, "--allow", allow_path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if VERBOSE:
        print(proc.stdout)
        if proc.stderr:
            print(proc.stderr)
    return proc


def main():
    tmp = tempfile.mkdtemp(prefix="package-files-fixture-")
    try:
        allow_path = os.path.join(tmp, "allow.yaml")

        # 1. No allowlist: the unpacked tracked file must be reported.
        repo = make_repo(tmp)
        proc = run_check(repo, allow_path)
        check("unlisted unpacked file fails the check", proc.returncode == 1, proc.returncode)
        check("failure names the file", "dev/preview.html" in proc.stdout, proc.stdout)
        check("failure explains both fixes", "allow.yaml" in proc.stdout, proc.stdout)
        check("lifecycle scripts never run", "PREPARE-RAN" not in proc.stdout + proc.stderr,
              (proc.stdout + proc.stderr)[-300:])

        # 2. `.gitignore` is excluded globally — it must not be reported.
        check("global defaults cover .gitignore", "pkg/.gitignore" not in proc.stdout, proc.stdout)

        # 3. Allowlisted by `**`: passes.
        write(allow_path, 'packages:\n  fixture-pkg:\n    - dev/**\n')
        proc = run_check(repo, allow_path)
        check("allowlisted file passes", proc.returncode == 0, proc.stdout + proc.stderr)

        # 4. Allowlisted by single-level `*` too (a `<dir>/**` is not the only way).
        write(allow_path, 'packages:\n  fixture-pkg:\n    - dev/*\n')
        proc = run_check(repo, allow_path)
        check("single-level glob also matches", proc.returncode == 0, proc.stdout + proc.stderr)

        # 5. The allowlist is not a blanket: a NEW unpacked file still fails.
        write(os.path.join(repo, "pkg", "styles.css"), "body{}\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        write(allow_path, 'packages:\n  fixture-pkg:\n    - dev/**\n')
        proc = run_check(repo, allow_path)
        check("allowlist is not a blanket", proc.returncode == 1, proc.returncode)
        check("new file is named", "styles.css" in proc.stdout, proc.stdout)

        # 6. A package without `files` is not this gate's business.
        repo2 = os.path.join(tmp, "repo2")
        os.makedirs(repo2)
        subprocess.run(["git", "init", "-q"], cwd=repo2, check=True)
        write(os.path.join(repo2, "plain", "package.json"), '{"name":"plain-pkg","version":"1.0.0"}\n')
        write(os.path.join(repo2, "plain", "index.js"), "// no whitelist\n")
        subprocess.run(["git", "add", "-A"], cwd=repo2, check=True)
        proc = run_check(repo2, allow_path)
        check("package without files is skipped", proc.returncode == 0, proc.stdout + proc.stderr)
        check("skipped package is reported", "nothing to check" in proc.stdout, proc.stdout)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if fails:
        print(f"{len(fails)} failing case(s)")
        return 1
    print("all package-files fixture cases pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
