# Automation Lifecycle

Every automation must have exactly one lifecycle status.

## 1. draft

Use when an automation is being designed and is not yet runnable end to end.

Typical conditions:

- entrypoint is a stub or does not run
- output contract still changing
- no workflow bound yet

## 2. testing

Use when the automation runs, but has not yet accumulated enough history to
trust its output.

Typical conditions:

- entrypoint runs end to end
- workflow bound and triggers successfully at least once
- output shape verified against the contract, but not yet validated over time

## 3. active

Use when the automation is trusted to run unattended.

Minimum expectation:

- has produced valid output on several consecutive scheduled runs
- failure modes are documented in its README
- registry metadata is current
- it does not silently stop: a missing run must be detectable from its output consumer

## 4. deprecated

Use when the automation should no longer be scheduled but is retained for
reference or migration. When possible, document the replacement in the registry.

## 5. archived

Use when the automation is retired. Disable or remove its workflow; do **not**
leave a scheduled workflow running against archived code.

## Rule

An automation that produces data another automation consumes must not be moved
to `archived` while the consumer is still `active` or `testing`.
