# Case #002 — the answer was "delete nothing"

Case #001 is about a repository with a lot of junk in it. This one is the opposite, and
it exists because a skill with only one kind of case nudges its reader toward that kind
of answer.

## What was asked

> Run me over this repository and tell me whether the classification rules are accurate.

## What was found

```text
BRANCH=feat/capability-mac-cleanup-npm   (another agent's branch, not main)
REPOSITORY_STATUS=CLEAN
untracked-but-not-ignored files: 0
```

Ignored and present: `.venv/` (13M), `.DS_Store` ×5, `__pycache__/` ×8, `dist/`,
`dist-test/`, `node_modules/`, `automations/ops-audit/config.local.json`.

## Classification

| candidate | verdict | why |
|---|---|---|
| `.venv/` | **KEEP** | ignored, 13M, looks like a cache — and is load-bearing. Tracked scripts invoke `.venv/bin/python3`. |
| `config.local.json` | **KEEP** | runtime state of an automation; correctly ignored |
| `.DS_Store` ×5 | DELETE (not executed) | macOS regenerates them; removing is cosmetic |
| `__pycache__/` ×8 | DELETE (not executed) | ~320K, rebuilt on next run |
| `dist/` `dist-test/` `node_modules/` | DELETE (not executed) | ~1M, `npm ci` rebuilds them |
| **the repository** | **nothing to do** | ~1.5M reclaimable, and most of it comes back the next time anything runs |

## What this case is for

**"Nothing to do" is a legitimate outcome, and it was the correct one here.** A clean
repository is not a failed audit. The observable that supports it is
`untracked-but-not-ignored = 0` — every ignored path was ignored on purpose.

## The defect it exposed

`.venv` passed `safe_delete_guard.sh`. The guard only asked git-state questions (is it
tracked? is it visible-untracked? is it .git?) and `.venv` is none of those — it is
ignored, which is the *normal* state for a cache.

The only thing standing between a 13M dependency directory and deletion was the sentence
in the PASS line: *"semantic DELETE classification and human approval still required"*.

That is too much weight for a warning string. The guard now asks one more deterministic
question — **is this path named anywhere in tracked content?** — and refuses if it is,
naming the file that references it. It is not a semantic judgement; it is a grep. But it
is the grep that separates "ignored" from "unused".

### Two things that went wrong while building it

1. `git grep` exits 1 when nothing matches. Under `set -euo pipefail` that status kills
   the guard — silently, and *before* it prints anything. A guard that dies quietly is
   worse than no guard. Fixed with `|| true`.
2. The first version excluded only the **root** `.gitignore`, so `.DS_Store` was blocked
   because a nested skill's ignore file names it. Every `.gitignore` at any depth is
   excluded now — being listed for exclusion is precisely the state this check looks
   past.

## What the rules did *not* catch

`config.local.json` still passes the guard: nothing tracked references it. That is
correct — the guard cannot know a file holds runtime state. This is the boundary
`classification-rules.md` describes: deterministic checks narrow the question, they do
not answer it.
