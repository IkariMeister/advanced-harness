# Preflight

`harness:preflight` collects pre-publish evidence for a task worktree. It reports
evidence only: no result, file, or tracker stamp counts as plan or publish
approval. The human approves.

```text
npm run harness:preflight -- --worktree <path> [--base <ref>] [--json]
```

## Base ref and trust model

`--base` is used when given. Otherwise the `baseBranch` recorded in project
context (`AGENTS.md` or the context file it links to) is used. There is no
hardcoded fallback; a missing or unreadable base is [inconclusive](glossary.md#workflow-and-tracking).

**Trust model:** When `--base` is omitted, `baseBranch` is read from the project
context in the worktree being inspected. If a task modifies its own `baseBranch` in
project context, the built-in `base-context` check emits a warning. Callers that
require an authoritative, tamper-proof base reference must pass `--base <ref>`
explicitly.

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
  `submodule` (gitlinks have no contents), or `other` (no contents). Contents are
  read in full with no size limit; limits on large files are left to the guardrail
  checks (BH-067..BH-071) that consume them.

## Result contract

```json
{ "approved": false, "blocking": [], "warnings": [], "metrics": {}, "checks": [{ "id": "changeset", "status": "pass", "evidence": [] }] }
```

> [!NOTE]
> The `approved` property in the result contract only indicates that all executed
> checks passed or warned (no checks blocked or were inconclusive). It is evidence
> only and **never** represents human or plan approval.

Each check reports `pass`, `warn`, `block`, or `inconclusive`. Checks run in
ascending `id` order. Metrics are prefixed with the check id. `approved` is true
only when at least one check ran and every check passed or warned. If no checks are
configured or if a check returns an unknown status, the result is inconclusive.

| Exit | Meaning |
| --- | --- |
| 0 | Pass (warnings allowed), or `--help` |
| 1 | Blocked by at least one check |
| 2 | Inconclusive (a git/tool call or check failed) or usage error |

A tooling error is never a pass.

## Adding checks

A check implements `PreflightCheck` from `src/preflight/types.ts`: a unique `id`
and a `run(context)` that receives the worktree and changeset and returns a
status, evidence lines, and optional numeric metrics. A thrown error becomes
`inconclusive`. The built-in `changeset` and `base-context` checks summarize the
changeset and warn on base branch modifications; guardrail checks (BH-067..BH-071)
plug in alongside them.
