#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--repo DIR] -- RELATIVE_PATH [...]" >&2
  echo "Read-only guard: it never deletes anything." >&2
}

repo="."
while (($#)); do
  case "$1" in
    --repo)
      (($# >= 2)) || { usage; exit 64; }
      repo=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: expected -- before paths" >&2
      usage
      exit 64
      ;;
  esac
done

(($# > 0)) || { usage; exit 64; }

root=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || {
  echo "ERROR: not a Git working tree: $repo" >&2
  exit 2
}

blocked=0
for rel in "$@"; do
  reason=""
  if [[ -z "$rel" || "$rel" = /* || "$rel" = "." || "$rel" = ".." || "$rel" = ../* || "$rel" = */../* || "$rel" = */.. ]]; then
    reason="unsafe or non-relative path"
  elif [[ "$rel" = ".git" || "$rel" = .git/* || "$rel" = */.git || "$rel" = */.git/* ]]; then
    reason="Git metadata is protected"
  elif [[ "$rel" = ".env" || "$rel" = .env.* || "$rel" = */.env || "$rel" = */.env.* ]]; then
    reason="environment and secret files require manual handling"
  fi

  abs="$root/$rel"
  if [[ -z "$reason" && ! -e "$abs" && ! -L "$abs" ]]; then
    printf 'PASS\t%s\talready absent (idempotent)\n' "$rel"
    continue
  fi
  if [[ -z "$reason" && -L "$abs" ]]; then
    reason="symlink targets are not resolved by this guard"
  fi
  if [[ -z "$reason" && -e "$abs/.git" ]]; then
    reason="candidate contains nested Git/worktree metadata"
  fi
  if [[ -z "$reason" && -n "$(git -C "$root" ls-files -- "$rel")" ]]; then
    reason="candidate contains tracked content"
  fi
  # Ignored does not mean unused. `.venv/` and `config.local.json` are both excluded by
  # .gitignore and both load-bearing: tracked scripts invoke `.venv/bin/python`, and the
  # config is the runtime state of an automation. Deleting either passes every other
  # check here. So ask one more deterministic question — is this path named anywhere in
  # tracked content? — and if it is, refuse and let a human read the reference.
  #
  # Every .gitignore/.gitattributes is excluded, at any depth. Being listed for
  # exclusion is exactly the state this check exists to look past, so counting the
  # listing would block every ignored candidate — including `.DS_Store`, which is
  # named in some nested ignore file and is pure junk. The first version of this
  # check only excluded the root .gitignore and produced exactly that false positive.
  if [[ -z "$reason" ]]; then
    ref=$(git -C "$root" grep -l -F -- "$rel/"             -- ':!.gitignore' ':!.gitattributes' ':!**/.gitignore' ':!**/.gitattributes' 2>/dev/null | head -1 || true)
    if [[ -n "$ref" ]]; then
      reason="referenced by tracked content ($ref) — confirm it is not a live dependency"
    fi
  fi
  if [[ -z "$reason" ]]; then
    path_status=$(git -C "$root" status --porcelain=v1 --untracked-files=all -- "$rel")
    if [[ -n "$path_status" && "$path_status" != '?? '* ]]; then
      reason="candidate has staged or modified Git state"
    fi
  fi
  if [[ -z "$reason" ]]; then
    if ! git -C "$root" check-ignore -q -- "$rel" 2>/dev/null && ! git -C "$root" check-ignore -q -- "$rel/" 2>/dev/null; then
      reason="candidate is visible untracked content, not ignored"
    fi
  fi

  if [[ -n "$reason" ]]; then
    printf 'BLOCK\t%s\t%s\n' "$rel" "$reason"
    blocked=1
  else
    printf 'PASS\t%s\tdeterministic checks passed; semantic DELETE classification and human approval still required\n' "$rel"
  fi
done

if ((blocked)); then
  exit 1
fi

