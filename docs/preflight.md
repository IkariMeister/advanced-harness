# Preflight

`harness:preflight` collects pre-publish evidence for a task worktree. It reports
evidence only: no result, file, or tracker stamp counts as plan or publish
approval. The human approves.

```text
npm run harness:preflight -- --worktree <path> [--base <ref>] [--task <key>] [--json]
```

## Base ref and trust model

`--base` is used when given. Otherwise the `baseBranch` recorded in project
context (`AGENTS.md` or the context file it links to) is used. There is no
hardcoded fallback; a missing or unreadable base is [inconclusive](glossary.md#workflow-and-tracking).

**Trust model:** Preflight uses the [trusted ref](glossary.md#workflow-and-tracking)
`refs/remotes/origin/HEAD`, read from the local repository without fetching:

- The built-in `base-context` check uses the trusted ref when `--base` is omitted.
  The worktree's linked context target (or `AGENTS.md` itself) and `baseBranch`
  must match the trusted ref; a difference blocks the run (`exit 1`). If the task
  modifies the project context file or the root `AGENTS.md` in its changeset, the
  check blocks the run (`exit 1`). If the trusted ref is missing, or the project
  context at the trusted ref is absent or unreadable, `base-context` is
  inconclusive (`exit 2`), and the evidence suggests passing `--base <ref>` or
  running `git remote set-head origin --auto`. When `--base <ref>` is passed
  explicitly, `base-context` skips the trusted-ref comparison and reports context
  modifications as informational.
- The built-in `worktree-boundary` check uses the trusted ref on every run (even
  when `--base` is passed explicitly and independent of whether context files
  appear in the changeset) to verify `worktreeDirectory`. If the trusted ref or
  the project context at the trusted ref is unavailable, absent, or unreadable,
  or if `worktreeDirectory` was modified compared to the trusted ref,
  the `worktree-boundary` check blocks (`status: 'block'`).
- Deleting or renaming the root `AGENTS.md`, or deleting or renaming the linked
  context file, leaves no readable project context in the worktree. Base resolution
  then fails when `--base` is omitted, which is inconclusive (`exit 2`), not a block.

The checks trust the local `refs/remotes/origin/HEAD` as configured; they do not verify
that ref against the remote. Callers that need an authoritative base reference can pass
`--base <ref>` explicitly to satisfy `base-context`. Note that `exitCodeFor` checks
`inconclusive` before `block`: an inconclusive result on any check yields overall exit code 2
even if another check reports `block`. When `refs/remotes/origin/HEAD` is missing and `--base` is
omitted, `base-context` is `inconclusive` while `worktree-boundary` reports `block`, resulting
in overall exit code 2. Passing `--base <ref>` satisfies `base-context`, yielding exit code 1
from the blocked `worktree-boundary` check.

## Changeset

The [changeset](glossary.md#workflow-and-tracking) is `merge-base(base, HEAD)...HEAD`
plus staged, unstaged, and untracked (not ignored) files. Each entry records its
path, previous path for renames, status (`added`, `modified`, `deleted`,
`renamed`), origin (`committed`, `staged`, `unstaged`, `untracked`), and contents.

- Entries are recorded per-origin: a file that is staged and then modified again
  in the working tree will appear as separate staged and unstaged entries.
- Unstaged renames are reported as an untracked add and an unstaged delete
  (unstaged rename detection `-M` is not run).
- A deleted file has no contents, which is distinct from a present zero-byte file.
- Entries also record `kind`: `file`, `symlink` (contents are the link target),
  `submodule` (gitlinks or nested git repositories have no contents), or `other`
  (no contents). Contents are read in full with no size limit; limits on large
  files are left to the guardrail checks (BH-067..BH-071) that consume them.

## Worktree boundary check

The built-in `worktree-boundary` check enforces that preflight is run in an
isolated task worktree under the project's configured `worktreeDirectory` and not
in the canonical checkout:

- Compares `--git-dir` and `--git-common-dir` from `git rev-parse`. If they resolve to
  the same directory, the target is the canonical checkout and is blocked (`exit 1`).
- Verifies the configured `worktreeDirectory` against the trusted ref
  (`refs/remotes/origin/HEAD`) on every run (independent of the changeset and even
  when `--base` is provided); altering the `worktreeDirectory` boundary or failing to
  verify against the trusted ref or trusted project context blocks the check (`status: 'block'`).
- Full project settings (`project` section in `AGENTS.md` or the linked context file; see
  [configuration.md](configuration.md)) are required at both the worktree and `refs/remotes/origin/HEAD`.
  Repositories with only an interim `paths` section are blocked (`status: 'block'`).
- Reads `worktreeDirectory` from project context. A missing `worktreeDirectory` or
  one that does not exist on disk blocks (`exit 1`). Shared-location resolution
  errors (such as conflict or invalid shape) are inconclusive (`exit 2`).
- Verifies that the resolved physical worktree path is strictly inside the resolved
  `worktreeDirectory` (realpath comparison, platform-aware). Any worktree outside the
  configured directory (or attempting directory traversal) is blocked (`exit 1`).
- **Optional task branch verification:** When `--task <key>` is passed (e.g. `--task 182`,
  `--task #182`, `--task BH-067`), the check inspects the checked-out branch. If `HEAD`
  is detached or the branch does not contain `<key>` as a case-insensitive, word-boundary
  token delimited by non-alphanumeric characters, the check blocks (`exit 1`). For example,
  `182` matches `issue/182`, `issue-182`, or `feat/182-worktree`, but does not match `1820`.

## Result contract

```json
{ "approved": false, "blocking": [], "warnings": [], "metrics": {}, "checks": [{ "id": "changeset", "status": "pass", "evidence": [] }] }
```

In the JSON result contract, `approved` is a boolean summarizing whether all executed
checks passed or warned (i.e. no check had a `block` or `inconclusive` status).
Programmatic consumers must treat `approved` strictly as an automated check verdict:
it is evidence only and **never** represents human or plan approval.

Each check reports `pass`, `warn`, `block`, or `inconclusive`. Checks run in
ascending `id` order. Metrics are prefixed with the check id. `approved` is true
only when at least one check ran and every check passed or warned. If no checks are
configured or if a check returns an unknown status, the result is inconclusive.

| Exit | Meaning |
| --- | --- |
| 0 | Pass (warnings allowed), or `--help` |
| 1 | Blocked by at least one check |
| 2 | Inconclusive (a git/tool call or check failed) or usage error |

`exitCodeFor` evaluates `inconclusive` before `block`: an inconclusive result on any check yields overall exit code 2 even if another check reports `block`. For example, when `refs/remotes/origin/HEAD` is missing and `--base` is omitted, `base-context` is `inconclusive` while `worktree-boundary` reports `block`, resulting in overall exit code 2. Passing `--base <ref>` allows `base-context` to pass, yielding exit code 1 from the blocked `worktree-boundary` check.

A tooling error is never a pass.

## Adding checks

A check implements `PreflightCheck` from `src/preflight/types.ts`: a unique `id`
and a `run(context)` that receives the worktree and changeset and returns a
status, evidence lines, and optional numeric metrics. A thrown error becomes
`inconclusive`. The built-in `changeset`, `base-context`, and `worktree-boundary`
checks summarize the changeset, block unverified project context modifications,
and ensure preflight runs within an isolated task worktree; guardrail checks
(BH-068..BH-071) plug in alongside them.
