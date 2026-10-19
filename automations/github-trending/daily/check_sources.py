#!/usr/bin/env python3
"""Surface degradation in a collection snapshot instead of burying it in JSON.

Why this exists: on 2026-10-19 the `trending-weekly` source died with
`TypeError: '>' not supported between 'NoneType' and 'int'`. The workflow still
reported **success**, the snapshot still got committed, and the only trace was a
string inside `warnings` — nobody noticed until a human happened to read it.

The collector's own contract is "one dead source degrades, never fails", and that
stays true: partial data is more useful than no data. So this gate does not abort
the run. It makes the degradation **loud**:

  * one `::warning::` annotation per warning (shows at the top of the run and in
    the checks UI)
  * a step summary table with the source-health line
  * a non-zero exit so the step itself is visibly marked, while the workflow
    keeps it from blocking the commit via `continue-on-error: true`

Exit codes:
  0  no warnings — every source produced its share
  1  at least one warning (degraded, but the snapshot is still worth committing)
  2  the snapshot is unusable (missing / unparseable / no candidates)
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Below this many candidates the snapshot is not "degraded", it is broken: even a
# day with a dead source normally yields well over 20.
MIN_CANDIDATES = 10


def check(document: dict) -> tuple[list[str], list[str]]:
    """Return (errors, warnings). Errors mean the snapshot is unusable."""
    errors: list[str] = []
    warnings: list[str] = [str(w) for w in (document.get("warnings") or [])]

    candidates = document.get("candidates")
    if not isinstance(candidates, list):
        errors.append("snapshot has no candidates array")
    elif len(candidates) < MIN_CANDIDATES:
        errors.append(
            f"only {len(candidates)} candidates (floor is {MIN_CANDIDATES}) — "
            "treat this snapshot as broken, not merely degraded"
        )

    if not document.get("topic_frequency"):
        warnings.append("topic_frequency is empty — rate-limit or markup change?")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", help="path to trending/<date>.json")
    parser.add_argument("--summary", help="append markdown to this file (GITHUB_STEP_SUMMARY)")
    args = parser.parse_args()

    if not os.path.isfile(args.snapshot):
        print(f"::error file={args.snapshot}::snapshot not found")
        return 2

    try:
        with open(args.snapshot, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"::error file={args.snapshot}::unparseable snapshot: {exc}")
        return 2

    errors, warnings = check(document)
    candidates = document.get("candidates") or []
    sources = sorted({
        str(c.get("source") or "?") for c in candidates if isinstance(c, dict)
    })

    for error in errors:
        print(f"::error file={args.snapshot}::{error}")
    for warning in warnings:
        print(f"::warning file={args.snapshot}::source degraded — {warning}")

    print(
        f"snapshot={os.path.basename(args.snapshot)} "
        f"candidates={len(candidates)} sources={sources} "
        f"warnings={len(warnings)} errors={len(errors)}"
    )

    if args.summary:
        lines = [
            "## Collection health",
            "",
            "| | |",
            "| --- | --- |",
            f"| snapshot | `{os.path.basename(args.snapshot)}` |",
            f"| candidates | {len(candidates)} |",
            f"| sources present | {', '.join(f'`{s}`' for s in sources) or '—'} |",
            f"| warnings | {len(warnings)} |",
            f"| errors | {len(errors)} |",
            "",
        ]
        if warnings or errors:
            lines.append("### Degradation")
            for item in errors:
                lines.append(f"- **ERROR** {item}")
            for item in warnings:
                lines.append(f"- WARNING {item}")
        else:
            lines.append("All sources produced data; no warnings.")
        lines.append("")
        with open(args.summary, "a", encoding="utf-8") as handle:
            handle.write("\n".join(lines))

    if errors:
        return 2
    return 1 if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
