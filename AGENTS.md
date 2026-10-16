# Working on Advanced Harness

## Recovery and backlog

Before planning changes to this harness repository, read:

1. `docs/backlog.md` — known pending work, stable IDs, and the dated recovery snapshot.
2. `README.md` — product scope and delivery overview.
3. `docs/configuration.md` — global connections/preferences versus project context.

Use these files rather than assuming previous chat context or the user's memory is
available. Inspect current Git/configuration and relevant service state before
acting on a dated snapshot. Distinguish reported observations from fresh verification.

Backlog entries and old snapshots are not authorization to implement, execute
project commands, change machine settings, publish, merge, or delete anything.
Confirm the latest scoped plan/approval when that context is missing. Never infer
successful checks, model entitlement, tool access, or completed external actions.

Keep `docs/backlog.md` current when an agreed feature, blocker, validation result,
deferral, or next action changes. Preserve stable IDs and unresolved work. Record
commit/PR references only after they exist; keep credentials out of recovery notes.
For project-scoped delivery tracking, mark an item complete when its PR is confirmed
open; track merge status separately. Never claim a PR is open
before External confirms it.

This repository is the harness tooling checkout, not the MarsRoverIA pilot app.
Preserve unrelated work in both repositories. Project settings belong only in the
application's AGENTS.md or explicitly referenced context; reusable connections and
defaults are global. Existing legacy profiles require explicit migration consent.

## Testing interactive CLI flows

- Redirected stdin is not interactive CLI QA. If no usable TTY is available, report
  the blocker and attribute any interactive smoke evidence to the human who ran it;
  do not present it as independently reproduced.
- Cover the CLI-used confirmation flow in regression tests, including cancellation
  with no writes or backups, alternate contexts, and shell default-on-Enter/retry
  behavior. Prefer exercising the actual flow over testing isolated prompt helpers.
