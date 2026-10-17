#!/usr/bin/env python3
"""Reuse Scan — is this asset already registered in the Store?

Reads every peer Domain registry **through the top-level router**, so the
router stays the single source of truth for where the registries live.
Deterministic and read-only.

Usage:
    python3 reuse_scan.py <asset-name> [<asset-name> ...]
    python3 reuse_scan.py <asset-name> --detail
    python3 reuse_scan.py --all

Exit codes:
    0   every requested name is NEW (safe to continue with first-publish)
   10   at least one name ALREADY EXISTS (switch to iterate, and ask the human)
    2   the Store or a registry could not be read
    3   PyYAML is not available

Requires: PyYAML (the Store already lists it in requirements-dev.txt).
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "ERROR: PyYAML is required. Install it with:\n"
        "  python3 -m pip install -r <store>/requirements-dev.txt\n"
    )
    sys.exit(3)

try:
    from store_root import resolve as resolve_store
except ImportError:  # pragma: no cover
    sys.stderr.write("ERROR: store_root.py must sit next to reuse_scan.py\n")
    sys.exit(2)

try:
    # Shared with check_tag_version.py: one list of Domains, so adding a Domain
    # cannot update one tool and silently leave the other answering about a
    # domain it never read.
    from domains import asset_sections
except ImportError:  # pragma: no cover
    sys.stderr.write("ERROR: domains.py must sit next to reuse_scan.py\n")
    sys.exit(2)


def fail(message: str, code: int = 2) -> None:
    sys.stderr.write(f"ERROR: {message}\n")
    sys.exit(code)


def load_yaml(path: str):
    try:
        with open(path, encoding="utf-8") as handle:
            return yaml.safe_load(handle)
    except FileNotFoundError:
        fail(f"missing file: {path}")
    except yaml.YAMLError as exc:
        fail(f"cannot parse {path}: {exc}")


def read_store(root: str):
    """Return (index, routers) where index maps asset-name -> (domain, entry)."""
    router = load_yaml(os.path.join(root, "registry.yaml"))
    routes = (router or {}).get("registries")
    if not isinstance(routes, dict):
        fail(f"{root}/registry.yaml has no 'registries' mapping")

    index = {}
    for domain, rel in routes.items():
        if not isinstance(rel, str):
            fail(f"router entry {domain!r} is not a path")
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            fail(f"router points at a missing file: {rel}")

    def load(rel):
        return load_yaml(os.path.join(root, rel))

    for domain, _rel, entries in asset_sections(routes, load, fail):
        for name, entry in entries.items():
            index[name] = (domain, entry)
    return index, routes


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    detail = "--detail" in flags
    list_all = "--all" in flags

    if not args and not list_all:
        fail("usage: reuse_scan.py <asset-name> [...] | --all [--detail]")

    root = resolve_store()
    if root is None:
        fail("could not locate the ai-capability-store checkout. "
             "Set AI_CAPABILITY_STORE and retry.")
    index, routes = read_store(root)

    print(f"Store: {root}")
    print(f"Registries: {', '.join(sorted(routes))}")
    print(f"Registered assets: {len(index)}")
    print()

    if list_all:
        if not index:
            print("  (none)")
        for name in sorted(index):
            domain, entry = index[name]
            status = entry.get("status", "?")
            version = entry.get("version", "?")
            print(f"  {name:<34} {domain:<22} status={status:<12} version={version}")
        return 0

    existing = []
    for name in args:
        if name in index:
            existing.append(name)
            domain, entry = index[name]
            print(f"EXISTS  {name}  (domain: {domain})")
            if detail:
                for key, value in entry.items():
                    print(f"          {key}: {value}")
        else:
            print(f"NEW     {name}")

    print()
    if existing:
        sys.stderr.write(
            f"ALREADY REGISTERED: {', '.join(existing)}. "
            "Do not add a second entry — switch to references/iterate.md and "
            "ask the human whether to update or skip.\n"
        )
        return 10
    return 0


if __name__ == "__main__":
    sys.exit(main())
