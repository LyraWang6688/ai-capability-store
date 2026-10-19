#!/usr/bin/env python3
"""Fixture tests for scripts/validate_store.py.

Why this exists. The validator was "tested" by running it against the real Store
and seeing every check pass. That proves no check *misfires*. It proves nothing
about whether a check would fire when it should — the real Store contains no broken
input, which is the whole point of a clean repository.

The failure this guards against is a check that quietly dies. Turn

    isinstance(tools, str) and not isinstance(tools, list)

into something always-true and the real Store still reports a clean run; nothing
anywhere notices. The only way to see a check work is to hand it the input it is
supposed to reject.

Each case: copy the tracked tree, break exactly one thing, run the validator,
assert the exit code. Same shape as the fixture tests for the store-publish scripts,
applied to the validator — which guards everything else.

Usage:
    python3 scripts/test_validator.py [-v]
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL_MD = os.path.join("skills", "repo-hygiene", "SKILL.md")
SKILL_REGISTRY = os.path.join("skills", "registry.yaml")
AUTOMATION_REGISTRY = os.path.join("automations", "registry.yaml")

VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv


# --- mutations ---------------------------------------------------------------
# Each takes the file text and returns the new text. Kept as data, not shell, so
# quoting cannot be the reason a case fails.

def _set_frontmatter_field(name, value):
    def mutate(text):
        if value is None:  # delete the line
            return re.sub(rf"(?m)^{re.escape(name)}:.*\n", "", text, count=1)
        return re.sub(rf"(?m)^{re.escape(name)}:.*$", f"{name}: {value}", text, count=1)
    return mutate


def _append_frontmatter(line):
    def mutate(text):
        assert text.startswith("---\n"), "not a frontmatter file"
        end = text.index("\n---", 4)
        return text[:end] + "\n" + line + text[end:]
    return mutate


def _duplicate_key(text):
    return text.replace("name: repo-hygiene", "name: repo-hygiene\nname: repo-hygiene", 1)


MUTATIONS = {
    "none": lambda t: t,
    # name
    "name-too-long": _set_frontmatter_field("name", "x" * 70),
    "name-uppercase": _set_frontmatter_field("name", "Repo-Hygiene"),
    "name-trailing-hyphen": _set_frontmatter_field("name", "repo-hygiene-"),
    "name-differs-from-key": _set_frontmatter_field("name", "repo-hygiene2"),
    # description
    "description-missing": _set_frontmatter_field("description", None),
    "description-too-long": _set_frontmatter_field("description", "d" * 1030),
    # compatibility
    "compatibility-too-long": _append_frontmatter("compatibility: " + "c" * 510),
    # metadata
    "metadata-value-not-string": _append_frontmatter("metadata: {k: 1}"),
    # license — shape check added in this change
    "license-as-list": _append_frontmatter("license: [MIT, Apache-2.0]"),
    "license-as-string": _append_frontmatter("license: MIT"),
    # allowed-tools — shape check added in this change
    "allowed-tools-as-list": _append_frontmatter("allowed-tools: [Read, Write]"),
    "allowed-tools-multiline-block": _append_frontmatter("allowed-tools: |\n  Read\n  Write"),
    "allowed-tools-empty": _append_frontmatter('allowed-tools: ""'),
    "allowed-tools-space-separated": _append_frontmatter("allowed-tools: Read Write Bash"),
    # external_trigger — shape added in this change
    "external-trigger-missing": lambda t: t.replace(
        "automations/investdesk-quote-sync/deploy/server-trigger.cron",
        "automations/investdesk-quote-sync/deploy/nope.cron", 1),
    "external-trigger-outside": lambda t: t.replace(
        "automations/investdesk-quote-sync/deploy/server-trigger.cron",
        "README.md", 1),
    # whitelist
    "unknown-field": _append_frontmatter("version: 9.9.9"),
    "duplicate-key": _duplicate_key,
}


# --- cases: (label, expected exit, file, mutation) ---------------------------
CASES = [
    ("untouched tree passes", 1, SKILL_MD, "none"),
    ("name longer than 64 is rejected", 1, SKILL_MD, "name-too-long"),
    ("name with uppercase is rejected", 1, SKILL_MD, "name-uppercase"),
    ("name with trailing hyphen is rejected", 1, SKILL_MD, "name-trailing-hyphen"),
    ("name unequal to registry key is rejected", 1, SKILL_MD, "name-differs-from-key"),
    ("missing description is rejected", 1, SKILL_MD, "description-missing"),
    ("description over 1024 is rejected", 1, SKILL_MD, "description-too-long"),
    ("compatibility over 500 is rejected", 1, SKILL_MD, "compatibility-too-long"),
    ("metadata value that is not a string is rejected", 1, SKILL_MD, "metadata-value-not-string"),
    ("license as a flow list is rejected", 1, SKILL_MD, "license-as-list"),
    ("license as a string passes", 0, SKILL_MD, "license-as-string"),
    ("allowed-tools as a flow list is rejected", 1, SKILL_MD, "allowed-tools-as-list"),
    ("allowed-tools as a multi-line block is rejected", 1, SKILL_MD, "allowed-tools-multiline-block"),
    ("allowed-tools as an empty string is rejected", 1, SKILL_MD, "allowed-tools-empty"),
    ("allowed-tools space-separated passes", 0, SKILL_MD, "allowed-tools-space-separated"),
    ("unknown frontmatter field is rejected", 1, SKILL_MD, "unknown-field"),
    ("duplicate frontmatter key is rejected", 1, SKILL_MD, "duplicate-key"),
    # external_trigger: the field is a claim about who fires the clock, and
    # the validator only accepts it with evidence on disk.
    ("external_trigger pointing at a missing file is rejected", 1,
     AUTOMATION_REGISTRY, "external-trigger-missing"),
    ("external_trigger outside its own directory is rejected", 1,
     AUTOMATION_REGISTRY, "external-trigger-outside"),
]

# The first case is the baseline: untouched, so it must pass.
CASES[0] = ("untouched tree passes", 0, SKILL_MD, "none")


def pristine_tree(dest):
    """Copy the tracked files AS THEY ARE IN THE WORKING TREE.

    Not `git archive HEAD`. That was the first implementation and it was wrong in a
    way this file's own meta-test caught: `git archive` reads the last commit, so a
    check being edited could not be tested without committing the broken version
    first. The fixture must see what you are about to commit.

    Tracked files only — `node_modules`, `.venv` and worktrees are not part of the
    contract, and an untracked scratch file should not silently become part of it.
    """
    listing = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True)
    if listing.returncode != 0:
        sys.exit(f"git ls-files failed: {listing.stderr.decode()[:300]}")
    for rel in listing.stdout.decode("utf-8").split("\0"):
        if not rel:
            continue
        src = os.path.join(ROOT, rel)
        if not os.path.isfile(src):
            continue  # deleted in the working tree
        dst = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def run_case(pristine, base, label, want, relpath, mutation):
    case = os.path.join(base, "case")
    shutil.rmtree(case, ignore_errors=True)
    shutil.copytree(pristine, case)

    target = os.path.join(case, relpath)
    with open(target, encoding="utf-8") as fh:
        text = fh.read()
    mutated = MUTATIONS[mutation](text)
    if mutated == text and mutation != "none":
        return False, f"{label}: mutation did not change the file"
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(mutated)

    proc = subprocess.run(
        [sys.executable, os.path.join(case, "scripts", "validate_store.py")],
        capture_output=True, text=True,
    )
    if proc.returncode != want:
        tail = "\n".join(proc.stdout.splitlines()[-3:])
        return False, f"{label}: expected exit {want}, got {proc.returncode}\n{tail}"
    if VERBOSE:
        last = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
        print(f"        {last}")
    return True, label


def main():
    try:
        import yaml  # noqa: F401
    except ImportError:
        sys.exit("PyYAML required: pip install -r requirements-dev.txt")

    base = tempfile.mkdtemp(prefix="validator-fixtures.")
    try:
        pristine = os.path.join(base, "pristine")
        os.makedirs(pristine)
        pristine_tree(pristine)

        print("validate_store.py fixtures")
        passed = failed = 0
        for label, want, relpath, mutation in CASES:
            ok, message = run_case(pristine, base, label, want, relpath, mutation)
            if ok:
                print(f"  ok    {label}")
                passed += 1
            else:
                print(f"  FAIL  {message}", file=sys.stderr)
                failed += 1

        print()
        if failed:
            print(f"FAIL: validator fixtures ({passed} passed, {failed} failed)")
            return 1
        print(f"PASS: validator fixtures ({passed} checks)")
        return 0
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
