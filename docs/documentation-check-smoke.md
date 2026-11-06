# Documentation checker discovery smoke

The offline documentation checker scans Markdown files directly in the repository
root and recursively scans `docs/`, `agents/`, `commands/`, and `skills/`. It does
not recursively search unrelated root directories (including hidden worktrees).
This bounds discovery while retaining checks for the maintained documentation
trees.

## Manual smoke test

Prerequisites: use an authorized disposable checkout or isolated copy with Node.js
24.x and dependencies installed, an interactive TTY, and a controlled multi-reply
PR-feedback fixture that can provide complete review-thread data without writing to
a live GitHub target. The fixture must include multiple replies in threads, resolved
thread context, and enough data to exercise pagination both for collecting threads
and for collecting each thread's replies through completion. Identify the fixture's
PR head and feedback state before the run. Do not use a live PR or add fixtures to a
shared or active worktree. If the authorized fixture or usable TTY is not available,
report this manual smoke as blocked; do not substitute redirected input, invent
tooling, or create live files. Ambiguous PR/thread targets or fixture state must
cause a stop before mutation. This smoke documents expected workflow behavior; it
does not assert that conversational approval is mechanically enforced.

1. In the disposable checkout, add a root Markdown file with a deliberately broken
   local link.
2. Add one Markdown file with a deliberately broken local link under each of
   `docs/`, `agents/`, `commands/`, and `skills/` (nested directories are permitted).
   Add equivalent fixtures under a hidden worktree directory such as
   `.worktrees/smoke/` and under an unrelated root subdirectory.
3. Use the controlled PR-feedback fixture interactively to request review feedback.
   Paginate thread collection to completion and, for every thread, paginate its
   replies collection to completion. Verify the result contains every comment and
   reply in every thread, including resolved threads, with full verbatim source text
   and stable source metadata (for example, thread/reply identity, author, and
   resolution state), not merely a complete-looking set of thread summaries.
4. At the proposed consequential confirmation, cancel. Verify cancellation causes
   no writes or backups in the disposable fixture.
5. Repeat only with a controlled fixture state where an explicitly selected finding
   has an authorized scoped fix. Verify only that selected fix is applied, unrelated
   and unselected findings remain untouched, and publication stays paused pending
   separate explicit approval. Do not perform GitHub writes.
6. Change the fixture's PR head or feedback state after review but before the
   proposed fix. Verify stale-state detection stops the operation without mutation.
   Also verify an ambiguous target stops before mutation.
7. In the interactive terminal run `npm run docs:check`, then remove only these
   disposable documentation fixtures after recording the result.

Expected: the workflow scenario presents complete paginated threads and complete
paginated replies within each thread, with every comment/reply's verbatim source
and stable metadata retained, including resolved context. Cancellation writes
nothing and creates no backups; an approved selected fix is limited to its scope
with publication paused; stale head/feedback and ambiguous target scenarios stop
without mutation. Separately, `npm run docs:check`
reports missing local destinations for the root file and all four allowed trees,
and reports neither fixture beneath the hidden worktree nor the unrelated directory.
The automated regression test covers the discovery rule, not live workflow behavior.
This manual smoke authorizes no live GitHub writes, replies, or publication.
