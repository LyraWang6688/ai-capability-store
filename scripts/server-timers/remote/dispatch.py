#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Standard-input dispatcher for GitHub Actions -> server DSH.

Installed at /srv/dsh-jobs/scripts/dispatch.py and invoked by the SSH forced
command /usr/local/bin/automation-accept:

    exec sudo -n runuser -u dshjobs -- env HOME=/srv/dsh-jobs \
         /srv/dsh-jobs/scripts/dispatch.py

Payload shape:
    {"kind":"github-trending-daily"|"github-trending-weekly"|"github-portfolio-snapshot", ...}

The dispatcher only routes; all judgement and side effects happen in the
per-task runner (see the sibling *-remote.py files).
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROUTES = {
    "github-trending-daily": "trending-daily-remote.py",
    "github-trending-weekly": "trending-weekly-remote.py",
    "github-portfolio-snapshot": "portfolio-remote.py",
}


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception:
        print(json.dumps({"ok": False, "error": "stdin is not JSON"}, ensure_ascii=False))
        return 2
    kind = payload.get("kind")
    script = ROUTES.get(kind)
    if not script:
        print(json.dumps({"ok": False, "error": "unknown kind %r" % kind}, ensure_ascii=False))
        return 2
    result = subprocess.run([sys.executable, os.path.join(HERE, script)],
                            input=raw, capture_output=True, text=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
