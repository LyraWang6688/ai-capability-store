#!/usr/bin/env python3
"""Duplicate guard — is this repository already collected?

The Bitable already contains repositories that were collected by hand. Writing
a candidate blindly creates a second row for the same project and silently
splits the source of truth. This script answers the "already there?" question
deterministically, BEFORE anything is written.

Matching is case-insensitive on the `Project` column (`owner/repo`), because
GitHub treats repository names case-insensitively.

Usage:
    python3 check_duplicate.py <owner/repo> [<owner/repo> ...]

Output:
    JSON object on stdout: existing projects, duplicates, and new candidates.

Exit codes:
    0  no candidate is already collected  -> safe to continue
   10  at least one candidate exists      -> STOP and ask the human
    2  the target table could not be read -> do not write
    3  lark-cli is not available
"""

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "target.json")


def fail(msg: str, code: int) -> None:
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(code)


def load_target() -> dict:
    with open(TARGET, encoding="utf-8") as fh:
        return json.load(fh)


def project_field(target: dict) -> dict:
    for field in target["fields"]:
        if field["name"] == "Project":
            return field
    fail("target.json has no Project field", 2)
    raise AssertionError  # unreachable


def read_existing(target: dict, field_id: str) -> list[tuple[str, str]]:
    """Return [(record_id, project)] for every row in the target table."""
    binary = shutil.which("lark-cli")
    if not binary:
        fail("lark-cli not found on PATH", 3)

    cmd = [
        binary, "base", "+record-list",
        "--base-token", target["base_token"],
        "--table-id", target["table_id"],
        "--field-id", field_id,
        "--as", target.get("identity", "user"),
        "--format", "json",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = proc.stdout.strip()
    if not out:
        fail(f"lark-cli produced no output (exit {proc.returncode}): {proc.stderr.strip()[:300]}", 2)
    try:
        payload = json.loads(out[out.index("{"):])
    except (ValueError, json.JSONDecodeError) as exc:
        fail(f"could not parse lark-cli output: {exc}", 2)
    if not payload.get("ok"):
        fail(f"table read failed: {json.dumps(payload.get('error'), ensure_ascii=False)}", 2)

    data = payload.get("data") or {}
    rows = data.get("data") or []
    ids = data.get("record_id_list") or []
    existing = []
    for i, row in enumerate(rows):
        value = row[0] if isinstance(row, list) and row else row
        project = value.strip() if isinstance(value, str) else ""
        if project:
            existing.append((ids[i] if i < len(ids) else "", project))
    if data.get("has_more"):
        fail("table read was paginated (has_more=true); refusing to claim a complete "
             "duplicate check. Re-run with a higher --limit.", 2)
    return existing


def main() -> int:
    candidates = sys.argv[1:]
    if not candidates:
        fail("usage: check_duplicate.py <owner/repo> [<owner/repo> ...]", 64)

    target = load_target()
    field = project_field(target)
    existing = read_existing(target, field["id"])

    index: dict[str, list[tuple[str, str]]] = {}
    for record_id, project in existing:
        index.setdefault(project.lower(), []).append((record_id, project))

    duplicates, fresh = [], []
    for slug in candidates:
        hits = index.get(slug.lower(), [])
        if hits:
            duplicates.append({
                "project": slug,
                "record_ids": [r for r, _ in hits],
                "matched_as": [p for _, p in hits],
            })
        else:
            fresh.append(slug)

    json.dump(
        {
            "table": target["table_name"],
            "existing_count": len(existing),
            "existing_projects": [p for _, p in existing],
            "duplicates": duplicates,
            "new": fresh,
        },
        sys.stdout, ensure_ascii=False, indent=2,
    )
    sys.stdout.write("\n")

    if duplicates:
        names = ", ".join(d["project"] for d in duplicates)
        sys.stderr.write(
            f"DUPLICATE: already collected: {names}. "
            "Do not insert a second row; ask the human whether to update or skip.\n"
        )
        return 10
    return 0


if __name__ == "__main__":
    sys.exit(main())
