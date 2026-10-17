#!/usr/bin/env python3
"""Pre-tag check — will the tag actually describe the commit you are about to tag?

`VERSIONING.md` §6 makes a namespaced tag the immutable snapshot of a version,
and the registry the place that version lives. The two must agree **at the tagged
commit** — otherwise `git checkout <asset>-vX.Y.Z` reads a registry that names a
different version, and "pin to X.Y.Z" does not deliver X.Y.Z.

Nothing fails loudly when they disagree. It is created by tagging before the
registry catches up — the version bump and the content change landing in
separate PRs — and it is found later, by hand. That happened four times in
October 2026; at the worst point 3 of 14 tags were affected.

This is the check that runs **before** `git tag`. It is deliberately NOT part of
`scripts/validate_store.py`: that validator is pure filesystem (no git, no
subprocess), so a tarball or a shallow checkout still validates. A tag question
is a git question, and it belongs in its own tool — see Issue #23.

Usage:
    python3 check_tag_version.py <asset-name> <version> [<commit>]
    python3 check_tag_version.py --audit

    <version>  X.Y.Z or vX.Y.Z
    <commit>   any rev; defaults to HEAD

Modes:
    default   check one tag you are about to create
    --audit   check every existing tag in the repository (this is what catches
              drift after the fact)

Checks (default mode):
    1. the tag <asset-name>-v<version> does not already exist
    2. the asset is registered in one of the peer Domain registries
       (Skills / External Capabilities / Automations)
    3. at <commit>, that registry already carries this version
    4. <commit> is reachable from main — tags belong on merged history

Exit codes:
    0   all checks passed — safe to tag
   10   at least one check failed (every failure is printed)
    2   usage error / not a git repository / unreadable registry
    3   PyYAML is not available

Read-only: it never creates, moves, or deletes a tag.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import yaml
except ImportError:  # pragma: no cover - environment dependent
    sys.stderr.write(
        "ERROR: PyYAML is required (the Store lists it in requirements-dev.txt).\n"
    )
    sys.exit(3)

try:
    from store_root import resolve as resolve_store
except ImportError:  # pragma: no cover - the script ships next to it
    sys.stderr.write("ERROR: store_root.py not found next to this script.\n")
    sys.exit(2)

try:
    # Shared with reuse_scan.py on purpose: when a Domain is added, both tools
    # must learn it, and one hardcoded list per script guarantees one is missed.
    from domains import asset_sections
except ImportError:  # pragma: no cover - the script ships next to it
    sys.stderr.write("ERROR: domains.py not found next to this script.\n")
    sys.exit(2)


def fail(message: str, code: int = 2):
    sys.stderr.write(f"ERROR: {message}\n")
    sys.exit(code)


def git(args, cwd):
    """Run git, returning (exit code, stdout). Never raises on a non-zero exit."""
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError as exc:  # pragma: no cover - git missing
        fail(f"could not run git: {exc}")
    return proc.returncode, proc.stdout.strip()


def normalise_version(raw: str) -> str:
    return raw[1:] if raw.startswith("v") else raw


def load_yaml_text(text: str):
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        fail(f"unparseable YAML: {exc}")


def registry_paths(store: str, commit):
    """Resolve the peer Domain registry paths, through the router at <commit>.

    The router is authoritative, and reading it at the commit keeps the answer
    correct for older tags (paths have been reorganised before).
    """
    code, text = git(["show", f"{commit}:registry.yaml"], store)
    if code != 0:
        fail(f"could not read registry.yaml at {commit}")
    router = load_yaml_text(text) or {}
    registries = router.get("registries")
    if not isinstance(registries, dict):
        fail("registry.yaml has no 'registries' mapping")
    return registries


def registered_version(store: str, commit, asset: str):
    """Return (domain, registry_path, version) for <asset> at <commit>, or None.

    Every peer Domain that carries versioned assets must appear in
    DOMAIN_ENTRY_KEYS. A domain routed in registry.yaml but missing here is a
    hard error rather than a silent skip: a checker that quietly ignores the
    newest Domain reports success for something it never looked at, which is the
    exact failure mode this script exists to prevent.
    """
    paths = registry_paths(store, commit)

    def load(rel):
        code, text = git(["show", f"{commit}:{rel}"], store)
        return load_yaml_text(text) if code == 0 else None

    for domain, rel, entries in asset_sections(paths, load, fail):
        if isinstance(entries.get(asset), dict):
            return domain, rel, entries[asset].get("version")
    return None


def tag_exists(store: str, name: str) -> bool:
    code, out = git(["tag", "-l", name], store)
    return code == 0 and out.strip() == name


def reachable_from_main(store: str, commit) -> bool:
    code, _ = git(["merge-base", "--is-ancestor", commit, "main"], store)
    return code == 0


def check_one(store: str, asset: str, version: str, commit: str) -> list:
    """Return a list of failure strings; empty means every check passed."""
    tag_name = f"{asset}-v{version}"
    problems = []

    print(f"checking {tag_name} at {commit}")
    print(f"  asset     {asset}")
    print(f"  version   {version}")

    if tag_exists(store, tag_name):
        problems.append(
            f"tag {tag_name} already exists — a version tag is immutable; "
            "if the content changed, bump the version instead of re-pointing it"
        )
    else:
        print(f"  tag       {tag_name} is free")

    found = registered_version(store, commit, asset)
    if found is None:
        problems.append(
            f"{asset} is not registered in any peer Domain registry at {commit}"
        )
        return problems

    domain, rel, at_commit = found
    print(f"  registry  {rel} ({domain})")
    print(f"  at commit version = {at_commit}")

    if normalise_version(str(at_commit)) != version:
        problems.append(
            f"{rel} says version {at_commit} at {commit}, but the tag would claim "
            f"{version}. Update the registry in the SAME PR as the content change, "
            "let it merge, then tag — a separate 'align the version' PR later "
            "cannot repair the commit the tag already points at"
        )

    if not reachable_from_main(store, commit):
        problems.append(
            f"{commit} is not reachable from main — tag merged history only; "
            "a tag on a feature branch dangles once the branch is deleted"
        )
    else:
        print("  reachable from main: yes")

    return problems


def audit(store: str) -> int:
    """Check every existing tag. Returns the number of failing tags."""
    code, out = git(["tag", "-l"], store)
    if code != 0:
        fail("could not list tags")
    tags = [t for t in out.splitlines() if t.strip()]
    if not tags:
        print("no tags in this repository")
        return 0

    head_code, head = git(["rev-parse", "main"], store)
    if head_code != 0:
        fail("no 'main' branch to audit against")

    failures = []
    checked = 0
    for tag in sorted(tags):
        name = tag
        # <asset-name>-vX.Y.Z ; the version is the last -v segment
        idx = name.rfind("-v")
        if idx <= 0:
            continue
        asset = name[:idx]
        version = normalise_version(name[idx + 1 :])
        commit = f"{tag}^{{commit}}"
        found = registered_version(store, commit, asset)
        if found is None:
            failures.append((tag, "asset not registered at that commit"))
            continue
        _, rel, at_commit = found
        checked += 1
        if normalise_version(str(at_commit)) != version:
            failures.append(
                (tag, f"{rel} at that commit says {at_commit}, tag claims {version}")
            )

    print(f"audited {len(tags)} tags; {checked} resolved to a registered asset")
    if failures:
        print()
        for tag, why in failures:
            print(f"  FAIL {tag}: {why}")
        print(f"\n{len(failures)} tag(s) disagree with the registry at their own commit")
        return len(failures)

    print("every tag agrees with the registry at the commit it points to")
    return 0


def main() -> int:
    args = sys.argv[1:]

    store = resolve_store()
    if store is None:
        fail("could not locate the Store (set AI_CAPABILITY_STORE)")

    code, _ = git(["rev-parse", "--git-dir"], store)
    if code != 0:
        fail(f"{store} is not a git repository")

    if args and args[0] == "--audit":
        return 10 if audit(store) else 0

    if len(args) < 2:
        sys.stderr.write(__doc__)
        return 2

    asset, version = args[0], normalise_version(args[1])
    commit = args[2] if len(args) > 2 else "HEAD"

    problems = check_one(store, asset, version, commit)
    if problems:
        print()
        for problem in problems:
            print(f"  FAIL {problem}")
        print(f"\n{len(problems)} check(s) failed — do NOT tag yet")
        return 10

    print()
    print(f"OK — safe to tag {asset}-v{version} at {commit}")
    print(f'  git tag -a {asset}-v{version} {commit} -m "{asset} v{version}"')
    return 0


if __name__ == "__main__":
    sys.exit(main())
