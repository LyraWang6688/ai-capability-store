#!/usr/bin/env python3
"""Locate the ai-capability-store checkout.

The Store path is deliberately NOT hardcoded. The workspace has been renamed
before, which silently broke every absolute path pointing at it; resolving at
run time is the fix that actually holds.

Resolution order:
  1. $AI_CAPABILITY_STORE
  2. well-known locations under the user's home
  3. walk up from the current directory
  4. walk up from this script's directory

A directory qualifies as the Store only if it carries the Store's signature
files (top-level router + all three domain registries), so a random git repo
named similarly will not be mistaken for it.

Usage:
    python3 store_root.py

Exit codes:
    0  found — absolute path on stdout
    2  not found — explanation on stderr
"""

import os
import sys

SIGNATURE = (
    "registry.yaml",
    os.path.join("skills", "registry.yaml"),
    os.path.join("external-capabilities", "registry.yaml"),
)


def looks_like_store(path: str) -> bool:
    return all(os.path.isfile(os.path.join(path, part)) for part in SIGNATURE)


def _walk_up(start: str):
    current = os.path.abspath(start)
    while True:
        yield current
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


def candidates():
    env = os.environ.get("AI_CAPABILITY_STORE")
    if env:
        yield os.path.expanduser(env)

    home = os.path.expanduser("~")
    for rel in (
        "Documents/workplace/ai-capability-store",
        "Documents/ai-capability-store",
        "workplace/ai-capability-store",
        "ai-capability-store",
    ):
        yield os.path.join(home, rel)

    yield from _walk_up(os.getcwd())
    yield from _walk_up(os.path.dirname(os.path.abspath(__file__)))


def resolve():
    seen = set()
    for raw in candidates():
        path = os.path.normpath(os.path.abspath(raw))
        if path in seen:
            continue
        seen.add(path)
        if looks_like_store(path):
            return path
    return None


def main() -> int:
    root = resolve()
    if root is None:
        sys.stderr.write(
            "ERROR: could not locate the ai-capability-store checkout.\n"
            "A directory qualifies only if it contains all of:\n"
            + "".join(f"  - {part}\n" for part in SIGNATURE)
            + "Set AI_CAPABILITY_STORE to the repository root and retry.\n"
        )
        return 2
    print(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
