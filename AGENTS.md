# Working on Advanced Harness

## Recovery and tracking

Before planning changes to this harness repository, read:

1. GitHub issues — known pending work, stable IDs, and current tracking state.
2. `README.md` — product scope and delivery overview.
3. `docs/configuration.md` — global connections/preferences versus project context.

Use these sources rather than assuming previous chat context or the user's memory is
available. Inspect current Git/configuration and relevant service state before
acting on a dated snapshot. Distinguish reported observations from fresh verification.

Issue entries and old snapshots are not authorization to implement, execute
project commands, change machine settings, publish, merge, or delete anything.
Confirm the latest scoped plan/approval when that context is missing. Never infer
successful checks, model entitlement, tool access, or completed external actions.

Keep GitHub issues current when an agreed feature, blocker, validation result,
deferral, or next action changes. Preserve stable IDs and unresolved work. Record
commit/PR references only after they exist; keep credentials out of recovery notes.
For project-scoped delivery tracking, mark an item complete when its PR is confirmed
open; track merge status separately. Never claim a PR is open
before External confirms it.

Repository settings may auto-delete a merged PR's remote branch and auto-close
its linked issue. After a merge, verify those states read-only through External
rather than repeating the writes, and report an unexpected state to the human.

## Publishing text

Commit messages, PR titles and bodies, and issue comments contain only the text the
human approved. Do not add attribution trailers (for example `Co-Authored-By`) or
other lines the human did not approve.

This repository is the harness tooling checkout, not the MarsRoverIA pilot app.
Preserve unrelated work in both repositories. Project settings belong only in the
application's AGENTS.md or explicitly referenced context; reusable connections and
defaults are global. Existing legacy profiles require explicit migration consent.

## Receipt-managed files

When implementing or testing receipt-managed file selections, use platform-aware
canonical file identity. When coalescing changes, preserve the earliest before-state
and latest after-state. Represent file absence separately from a present zero-byte
file. For foreign ownership, an explicitly absent after-state is not active ownership;
retain validation and pending-operation guards.

## Terminology

Use the meanings in `docs/glossary.md` in docs, ADRs, agent contracts, and issues.
Qualify ambiguous terms as the glossary does (for example "review tier", not "tier").
Add or change a term in the glossary in the same change that first uses it; meanings
from other projects do not apply unless the glossary adopts them.

## Testing interactive CLI flows

- Redirected stdin is not interactive CLI QA. If no usable TTY is available, report
  the blocker and attribute any interactive smoke evidence to the human who ran it;
  do not present it as independently reproduced.
- Cover the CLI-used confirmation flow in regression tests, including cancellation
  with no writes or backups, alternate contexts, and shell default-on-Enter/retry
  behavior. Prefer exercising the actual flow over testing isolated prompt helpers.
