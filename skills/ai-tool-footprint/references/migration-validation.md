# Store migration validation — 2026-10-20

Scope: register the existing local skill as Store-native source, preserve its seven source files byte-for-byte, and replace the local installation with a symlink to the Store directory. Exclude generated Python bytecode; do not import personal footprint data, reports, credentials, or this chat's scratch artifacts.

## Checks

- Reuse scan: no existing ai-tool-footprint registration across the Store domains.
- Source origin: the installed skill directory and the known archived report directory are not Git repositories; no ai-tool-footprint path history exists in this Store checkout. No source Git history was available in these inspected locations.
- Source parity: all seven existing source files have identical SHA-256 digests in the prepared Store copy. Additions are agents/openai.yaml and this validation note.
- Store validator on the prepared tree: 1059 checks, 0 failures.
- Ecosystem validation: `npx skills-ref validate skills/ai-tool-footprint` PASS on the prepared tree.
- Representative script checks from this revision: Python source compilation; temporary synthetic SQLite WAL record retained by the snapshot helper; synthetic timeline rendered using Pillow. No personal sources scanned by those checks.
- Incremental collection and article generation: instructions and state schema only; not rerun end-to-end during migration. The collector remains a full auxiliary scanner.

Registration remains testing at 0.1.0, not active. This note does not assert publication, a Git commit, PR approval, or release tagging. Local symlink resolution and file parity must be checked again after applying the migration.

## Applied readback

The local Agent Skills path resolves to the canonical Store skill directory. All seven original source file SHA-256 digests match after replacement. Work is on feature branch feat/ai-tool-footprint-store-source; changes are uncommitted.
