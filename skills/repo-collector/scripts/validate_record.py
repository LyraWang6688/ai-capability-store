#!/usr/bin/env python3
"""Pre-write schema gate for repo-collector.

Validates a candidate record against the live field contract in
`target.json` BEFORE anything reaches the Bitable. A record that fails here
must not be written.

This is the deterministic-protection layer: the LLM decides what a record
MEANS; this script decides whether the record is structurally WRITABLE.

Usage:
    python3 validate_record.py <record.json>

Input file accepts either:
    { ...one record... }
    [ {...record...}, {...record...} ]

Exit codes:
    0  every record is valid
    1  at least one record is invalid (reasons on stdout)
   64  usage / unreadable input
"""

import datetime
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "target.json")


def load_target() -> dict:
    with open(TARGET, encoding="utf-8") as fh:
        return json.load(fh)


def non_empty(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return True


def check_field(field: dict, value, errors: list[str]) -> None:
    name = field["name"]
    ftype = field["type"]
    if field.get("required") and not non_empty(value):
        errors.append(f"{name}: required but missing/empty")
        return
    if not non_empty(value):
        return

    if ftype == "text":
        if not isinstance(value, str):
            errors.append(f"{name}: expected string, got {type(value).__name__}")
            return
        limit = field.get("max_text_len") or 1000
        if len(value) > limit:
            errors.append(f"{name}: {len(value)} chars exceeds sanity cap {limit}")
        pattern = field.get("pattern")
        if pattern and not re.match(pattern, value.strip()):
            errors.append(f"{name}: {value!r} does not match {pattern}")
        # Closed source contract: a field that must come from a declared fact
        # source rejects values pointing somewhere that source cannot produce.
        # e.g. 前端网页 must be a real site, never a GitHub-internal path.
        for prefix in field.get("exclude_prefixes", []):
            if prefix in value:
                errors.append(f"{name}: {value!r} contains excluded prefix {prefix!r}")

    elif ftype == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            errors.append(f"{name}: expected number, got {type(value).__name__}")
        elif value < 0:
            errors.append(f"{name}: must be >= 0, got {value}")

    elif ftype == "select":
        options = field["options"]
        if not isinstance(value, list):
            errors.append(f"{name}: expected array of options, got {type(value).__name__}")
            return
        if not field.get("multiple") and len(value) != 1:
            errors.append(f"{name}: single-select needs exactly 1 option, got {len(value)}")
        if field.get("multiple") and len(set(map(str, value))) != len(value):
            errors.append(f"{name}: duplicate options {value!r}")
        unknown = [v for v in value if v not in options]
        if unknown:
            errors.append(f"{name}: option(s) not in table schema: {unknown} (allowed: {options})")

    elif ftype == "datetime":
        if not isinstance(value, str):
            errors.append(f"{name}: expected ISO-8601 string, got {type(value).__name__}")
            return
        try:
            datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"{name}: {value!r} is not a parseable ISO-8601 datetime")


def validate_record(record: dict, target: dict) -> list[str]:
    errors: list[str] = []
    known = {f["name"] for f in target["fields"]}
    unknown = [k for k in record if k not in known]
    if unknown:
        errors.append(f"unknown field(s) not in table schema: {unknown}")

    for field in target["fields"]:
        check_field(field, record.get(field["name"]), errors)

    # Cross-field: the link and the identity must agree.
    project = record.get("Project")
    url = record.get("Repository URL")
    if isinstance(project, str) and isinstance(url, str):
        expected = target["url_template"].format(project=project)
        if url.strip() != expected:
            errors.append(f"Repository URL must be exactly {expected!r}, got {url.strip()!r}")

    return errors


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: validate_record.py <record.json>\n")
        return 64
    try:
        with open(sys.argv[1], encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"ERROR: cannot read {sys.argv[1]}: {exc}\n")
        return 64

    records = payload if isinstance(payload, list) else [payload]
    target = load_target()

    failures = 0
    for i, record in enumerate(records):
        if not isinstance(record, dict):
            print(f"[FAIL] record {i}: not a JSON object")
            failures += 1
            continue
        errors = validate_record(record, target)
        label = record.get("Project") or f"record {i}"
        if errors:
            failures += 1
            print(f"[FAIL] {label}")
            for err in errors:
                print(f"       - {err}")
        else:
            print(f"[PASS] {label}")

    print(f"\n{len(records)} record(s), {failures} invalid")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
