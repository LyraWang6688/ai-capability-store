#!/usr/bin/env python3
"""Package files — every tracked file in a published package is shipped or explicitly excluded.

Why this exists. `files` in package.json is an npm allowlist: only matching paths
enter the tarball. A file that never made it into that list is dropped
**silently** — `npm publish` succeeds, `npm install` succeeds, and the only
symptom is a feature that does not work (a missing locale, icon, stylesheet or
module). Nothing was asking "is every file in this package accounted for?", so
the answer depended on whoever remembered to edit `files`.

This tool asks it. For every tracked `package.json` that declares `files`:

1. `npm pack --dry-run --json` over a script-free copy of the package's tracked
   files → the tarball npm would produce (no publish, no network, no `prepare`
   build — the gate must not depend on whether the package currently compiles);
2. `git ls-files` → the files that exist in the repository for that package;
3. every tracked file must be either packed, or named in
   `scripts/package-files/allow.yaml` as explicitly *not* shipped.

The allowlist is the point: "we forgot" and "we decided this is development-only"
stop looking the same. Adding a file to a package is a two-way choice, never a
silent default.

Scope. Only the *under-shipping* direction is checked here. Over-shipping cannot
happen by default because the Store uses an allowlist; the opposite model
(`.npmignore`, ship-everything) is the one that leaks source and tests, and it is
rejected on purpose (`SKILL-FORMAT.md` / `PUBLISHING.md` §D use `files`).

Why not in `validate_store.py`: that script is deliberately pure-filesystem (no
git, no subprocess) so a tarball or shallow checkout still validates. "Would npm
ship this?" is an npm+git question and belongs in its own tool — the same reason
`check_tracked_hygiene.py` exists.

Usage:
    python3 scripts/check_package_files.py [--root PATH] [--allow PATH] [--verbose]

Exit codes:
    0   clean
    1   at least one tracked file is neither packed nor allowlisted
    2   git / npm / the allowlist could not be used
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_ALLOW = ROOT / "scripts" / "package-files" / "allow.yaml"

# Files npm never puts in a tarball, whatever `files` says. These are facts about
# npm, not decisions about the package, so they do not belong in the allowlist.
BUILTIN_GLOBAL = (".gitignore", ".npmignore", "package-lock.json")


# --- plumbing ----------------------------------------------------------------


def die(message: str) -> "NoReturn":
    sys.stderr.write(f"[ENV] {message}\n")
    raise SystemExit(2)


def run(cmd: list[str], cwd: pathlib.Path, env: dict | None = None):
    try:
        return subprocess.run(
            cmd, cwd=str(cwd), env=env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
    except OSError as exc:  # pragma: no cover - missing binary
        die(f"could not run {cmd[0]}: {exc}")


def git_tracked(root: pathlib.Path) -> list[str]:
    proc = run(["git", "ls-files", "-z"], root)
    if proc.returncode != 0:
        die(f"could not list tracked files — is {root} a git checkout?\n{proc.stderr.strip()}")
    return [path for path in proc.stdout.split("\0") if path]


# --- discovery ---------------------------------------------------------------


def packages(root: pathlib.Path, tracked: list[str]) -> list[tuple[pathlib.PurePosixPath, dict]]:
    """Every tracked package.json that declares a `files` whitelist."""
    found: list[tuple[pathlib.PurePosixPath, dict]] = []
    for path in tracked:
        if not path.endswith("package.json"):
            continue
        if path == "package.json" or "/node_modules/" in f"/{path}":
            # A repository-root package.json is the repo's own manifest, not a
            # published asset; node_modules is never ours to judge.
            continue
        try:
            meta = json.loads((root / path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue  # not valid JSON is someone else's problem, not this gate's
        if not isinstance(meta, dict) or "files" not in meta:
            continue
        found.append((pathlib.PurePosixPath(path).parent, meta))
    return sorted(found, key=lambda item: str(item[0]))


def packaged(
    root: pathlib.Path,
    rel_dir: pathlib.PurePosixPath,
    tracked: list[str],
    npm_cache: str,
) -> set[str]:
    """The files npm would ship for this package dir — asked in a script-free copy.

    `npm pack` runs `prepare` / `prepack`, and those can invoke a build (`tsc`)
    against a tree whose dependencies are not installed: CI runs this gate before
    `npm ci`, so packing the real directory fails for a reason that has nothing to
    do with the question being asked (it failed exactly that way on the first CI
    run). The copy below holds exactly the tracked files — which is what this gate
    reasons about — with `scripts` removed, so npm applies its `files` rules
    without executing anything.
    """
    prefix = f"{rel_dir}/" if str(rel_dir) not in ("", ".") else ""
    files = [path[len(prefix):] for path in tracked if path.startswith(prefix)]

    env = dict(os.environ)
    env["npm_config_cache"] = npm_cache          # hermetic: never touch the user's cache
    env["npm_config_loglevel"] = "error"
    env["npm_config_update_notifier"] = "false"

    with tempfile.TemporaryDirectory(prefix="pkg-", dir=npm_cache) as tmp:
        work = pathlib.Path(tmp)
        for rel in files:
            if rel in (".gitignore", ".npmignore"):
                # npm reads these as ignore rules; a copy must not re-filter itself.
                continue
            source, target = root / prefix / rel, work / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        manifest = work / "package.json"
        if manifest.exists():
            meta = json.loads(manifest.read_text(encoding="utf-8"))
            meta.pop("scripts", None)
            manifest.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        proc = run(
            ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
            cwd=work, env=env,
        )

    if proc.returncode != 0:
        die(f"npm pack failed for {rel_dir}:\n{proc.stderr.strip()}")
    try:
        data = json.loads(proc.stdout)
        return {entry["path"] for entry in data[0]["files"]}
    except (json.JSONDecodeError, KeyError, IndexError) as exc:
        die(f"could not read npm pack output for {rel_dir}: {exc}")


def tracked_in(rel_dir: pathlib.PurePosixPath, tracked: list[str]) -> set[str]:
    prefix = f"{rel_dir}/" if str(rel_dir) not in ("", ".") else ""
    return {path[len(prefix):] for path in tracked if path.startswith(prefix)}


# --- allowlist ---------------------------------------------------------------


def load_allow(path: pathlib.Path) -> tuple[list[str], dict[str, list[str]]]:
    if not path.exists():
        return [], {}
    try:
        import yaml  # noqa: PLC0415 — keep the import local so --help works without it
    except ImportError:
        die("PyYAML is missing — pip install -r requirements-dev.txt")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        die(f"{path}: expected a mapping at the top level")
    defaults = [str(pattern) for pattern in (data.get("global") or [])]
    per_package = {
        str(name): [str(pattern) for pattern in (patterns or [])]
        for name, patterns in (data.get("packages") or {}).items()
    }
    return defaults, per_package


def matches(rel_path: str, patterns: list[str]) -> bool:
    """Path-aware glob: `*` does not cross `/`, `**` does. Predictable beats clever."""
    rel_parts = rel_path.split("/")

    def walk(pattern: str, index: int, depth: int) -> bool:
        parts = pattern.split("/")
        if index == len(parts):
            return depth == len(rel_parts)
        if parts[index] == "**":
            return any(walk(pattern, index + 1, skip) for skip in range(depth, len(rel_parts) + 1))
        if depth == len(rel_parts):
            return False
        return (
            fnmatch.fnmatchcase(rel_parts[depth], parts[index])
            and walk(pattern, index + 1, depth + 1)
        )

    return any(walk(pattern, 0, 0) for pattern in patterns)


# --- main --------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Every tracked package file is shipped or explicitly excluded")
    parser.add_argument("--root", default=str(ROOT), help="repository root (default: this checkout)")
    parser.add_argument("--allow", default=str(DEFAULT_ALLOW), help="allowlist file")
    parser.add_argument("--verbose", action="store_true", help="print per-package counts")
    args = parser.parse_args()

    root = pathlib.Path(args.root).resolve()
    allow_path = pathlib.Path(args.allow).resolve()
    if not (root / ".git").exists():
        die(f"{root} is not a git checkout")

    for binary in ("git", "npm"):
        if shutil.which(binary) is None:
            die(f"{binary} not found on PATH")

    defaults, per_package = load_allow(allow_path)
    tracked = git_tracked(root)
    pkgs = packages(root, tracked)
    if not pkgs:
        print("no tracked package.json declares a `files` whitelist — nothing to check")
        return 0

    offenders: list[tuple[str, list[str]]] = []
    npm_cache = tempfile.mkdtemp(prefix="package-files-npm-cache-")
    try:
        for rel_dir, meta in pkgs:
            name = str(meta.get("name") or rel_dir)
            packed = packaged(root, rel_dir, tracked, npm_cache)
            files = tracked_in(rel_dir, tracked)
            allowed = list(BUILTIN_GLOBAL) + defaults + per_package.get(name, [])
            unpacked = files - packed
            excluded = sorted(path for path in unpacked if matches(path, allowed))
            missing = sorted(path for path in unpacked if not matches(path, allowed))
            if args.verbose:
                print(
                    f"  {name:40} tracked={len(files):2} packed={len(packed):2} "
                    f"excluded={len(excluded):2} unaccounted={len(missing)}"
                )
            if missing:
                offenders.append((name, missing))
    finally:
        shutil.rmtree(npm_cache, ignore_errors=True)

    print(f"checked {len(pkgs)} package(s) with a `files` whitelist")
    known = {str(meta.get("name") or rel_dir) for rel_dir, meta in pkgs}
    stale = sorted(set(per_package) - known)
    if stale:
        # A renamed/retired package leaves its exclusions behind. Not a failure —
        # the file is still the right place to record "this never ships" — but the
        # allowlist should not accumulate names that no longer exist.
        print(f"note: allowlist names package(s) not in this checkout: {', '.join(stale)}")
    if not offenders:
        print("every tracked file is either packed or explicitly excluded")
        return 0

    total = sum(len(missing) for _, missing in offenders)
    print()
    for name, missing in offenders:
        print(f"[FAIL] {name}")
        for path in missing:
            print(f"       {path}")
    print(f"\n{total} file(s) in {len(offenders)} package(s) are accounted for by neither side:")
    print("  - ship it:   add the path (or a glob) to package.json \"files\"")
    print(f"  - not shipped: add it to {allow_path.relative_to(root) if allow_path.is_relative_to(root) else allow_path}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
