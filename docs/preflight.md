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
context in the worktree being inspected. The built-in `base-context` check compares
that context with the project context at the [trusted ref](glossary.md#workflow-and-tracking)
`refs/remotes/origin/HEAD`, read from the local repository without fetching:

- The linked context target (or `AGENTS.md` itself) and `baseBranch` must match the
  trusted ref. A difference blocks the run (`exit 1`).
- If the task modifies the project context file or the root `AGENTS.md` in its
  changeset, the check blocks the run (`exit 1`). This also covers other context
  modifications that leave the target and `baseBranch` unchanged.
- Deleting or renaming the root `AGENTS.md`, or deleting or renaming the linked
  context file, leaves no readable project context in the worktree. Base resolution
  then fails when `--base` is omitted, which is inconclusive (`exit 2`), not a block.
- If the trusted ref is missing, or the project context at the trusted ref is
  absent or unreadable, the result is inconclusive (`exit 2`). The evidence names the
  fix: pass `--base <ref>` or run `git remote set-head origin --auto`.

The check trusts the local `refs/remotes/origin/HEAD` as configured; it does not verify
that ref against the remote. Callers that need an authoritative base reference can pass
`--base <ref>` explicitly. With `--base`, the trusted-ref comparison is skipped and
context modifications are reported as informational.

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
- Entries also record `kind`: `file`, `symlink` (contents are the link target, read
  without following it),
  `submodule` (gitlinks or nested git repositories have no contents), or `other`
  (no contents). Contents are read in full with no size limit; limits on large
  files are left to the guardrail checks (BH-067..BH-071) that consume them.
- Text entries include added lines and their target line numbers, grouped by
  committed net diff, staged, unstaged, and untracked origin.
- Added-line extraction uses Git's literal path mode, disables external diff and
  textconv, and binds each diff to exact repository paths. For detected renames,
  extraction includes both old and destination paths; the regression test verifies
  destination line numbers. Binary or otherwise undecodable diffs are marked
  incomplete and make secret scanning inconclusive, with affected paths reported.
- The changeset contains all file bytes, but secret-scanner input is bounded to
  4 MiB aggregate UTF-8 payload. The cap is checked before either scanner is
  selected or invoked; oversized input is inconclusive. Added blank lines are retained, and
  the scanner receives separate contiguous runs per file and origin. Empty input
  skips the scanner subprocess. The Gitleaks invocation has a fixed 10-second
  timeout. Untracked symlinks are not followed and make secret scanning
  inconclusive.
- `path-policy` blocks configured sensitive paths (including rename destinations)
  and skips deletions. The default glob list is case-insensitive and project
  replaceable. Rule exceptions require an exact path/rule pair and a trimmed,
  nonblank justification; exceptions never change path policy.
- Default path globs: `**/.env*`, `**/id_rsa*`, `**/.DS_Store`, `**/keys/**`,
  `**/keystores/**`, `**/*.key`, `**/*.pem`, `**/*.p12`, `**/*.pfx`,
  `**/*.jks`, `**/*.keystore`, `**/build/**`, and `**/dist/**`.
  Preflight reads `.harness/preflight.json` (`forbiddenPathGlobs`) and
  `.harness/preflight-allowlist.json` from the explicit `--base` commit, or from
  `refs/remotes/origin/HEAD` when base comes from project context. It never reads
  candidate working-tree policy contents. Changes to either policy file in
  the candidate changeset block pending review. Programmatic `runPreflight`
  callers can explicitly supply `sensitivePathGlobs` and `secretExceptions`; these
  caller-supplied values take precedence over the trusted files. Projects provide justified exceptions in
  `.harness/preflight-allowlist.json`, a JSON array of entries containing `path`,
  `rule`, and a nonblank `justification`; programmatic callers use
  `secretExceptions`. Project policy is validated after resolving the changeset
  base and before check execution or secret scanning.
  Custom `checks` cannot be combined with explicit policy overrides or configured
  project policy. Exceptions are normalized for separators and a leading `./`,
  then match the exact path/rule pair. Their trimmed justification is never shown;
  the full normalized path is retained for matching, while display escapes control
  characters and shortens very long paths. Metrics report only how many findings
  were excepted. For Gitleaks findings, the
  displayed rule is a stable SHA-256 label; exceptions use the exact upstream
  Gitleaks `RuleID` so arbitrary report identifiers are never emitted.
- Secret scanning uses the shared bounded scanner probe described in
  [ADR-006](adr/0006-preflight-scope-and-redaction.md). Gitleaks uses the checked-in
  `src/preflight/gitleaks.toml` default-rule config, a neutral working directory,
  and an environment with all `GITLEAKS_*` variables removed. Scanner payload is
  passed on stdin; output is reduced to sanitized rule/location records. If
  Gitleaks is absent, a documented built-in high-confidence detector runs. An
  installed but unusable probe or failed/malformed scan is inconclusive. Metrics
  distinguish Gitleaks, built-in, and unavailable backend states.
- Gitleaks is invoked as `gitleaks stdin --report-format json --report-path
  <temporary-report> --redact=100 --no-banner` with the pinned config argument;
  JSON findings use `RuleID` and `StartLine`. Exit code 1 is accepted only when the report parses as valid
  nonempty findings, and exit code 0 only with an empty report. The temporary
  temporary report directory is removed after all runs finish or fail. Gitleaks `RuleID` values are
  emitted as stable SHA-256 labels; exact exceptions match the upstream ID.

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

A tooling error is never a pass.

## Adding checks

A check implements `PreflightCheck` from `src/preflight/types.ts`: a unique `id`
and a `run(context)` that receives the worktree and changeset and returns a
status, evidence lines, and optional numeric metrics. A thrown error becomes
`inconclusive`. The built-in `changeset` and `base-context` checks summarize the
changeset and block unverified project context modifications; guardrail checks
(BH-067..BH-071) plug in alongside them.
