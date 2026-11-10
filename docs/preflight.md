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
- The [project policy](#project-policy) is always read from the trusted ref, with or
  without `--base`. A worktree copy of the policy never takes effect: a difference is
  reported as `warn` (`policy` check) and applies only after it reaches origin/HEAD. If
  the trusted ref is unavailable while the worktree records a policy, every check is
  inconclusive. With no policy in the worktree, an unavailable trusted ref behaves as before.

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
- Entries also record `kind`: `file`, `symlink` (contents are the link target),
  `submodule` (gitlinks or nested git repositories have no contents), or `other`
  (no contents). Contents are read in full with no size limit; limits on large
  files are left to the guardrail checks (BH-067..BH-071) that consume them.
- Text entries include added lines and their target line numbers, grouped by
  committed net diff, staged, unstaged, and untracked origin.
- Added-line extraction binds each diff to the exact repository path instead of
  parsing Git's quoted path header. Binary or otherwise undecodable diffs are
  marked incomplete and make secret scanning inconclusive.
- `path-policy` blocks configured sensitive paths (including rename destinations)
  and skips deletions. The default glob list is case-insensitive and project
  replaceable. Rule exceptions require an exact path/rule pair and a trimmed,
  nonblank justification; exceptions never change path policy.
- Default path globs: `**/.env*`, `**/id_rsa*`, `**/.DS_Store`, `**/keys/**`,
  `**/keystores/**`, `**/*.key`, `**/*.pem`, `**/*.p12`, `**/*.pfx`,
  `**/*.jks`, `**/*.keystore`, `**/build/**`, and `**/dist/**`.
  The list can be extended (`add`) or replaced (`replace`) only by the trusted-ref
  [project policy](#project-policy) `forbiddenGlobs`. Programmatic `runPreflight` callers
  provide exact `secretExceptions` entries containing `path`, `rule`, and a nonblank
  `justification`. For Gitleaks findings, the
  displayed rule is a stable SHA-256 label; exceptions use the exact upstream
  Gitleaks `RuleID` so arbitrary report identifiers are never emitted.
- Secret scanning uses the shared bounded scanner probe described in
  [ADR-005](adr/0005-preflight-scope-and-redaction.md). Scanner payload is passed
  on stdin; output is reduced to sanitized rule/location records. If Gitleaks is
  absent, a documented built-in high-confidence detector runs. Scanner failures
  and malformed output are inconclusive.
- Gitleaks is invoked as `gitleaks stdin --report-format json --report-path
  <temporary-report> --redact=100 --no-banner`; JSON findings use `RuleID` and
  `StartLine`. Exit code 1 is accepted only when the report parses as valid
  nonempty findings, and exit code 0 only with an empty report. The temporary
  report is removed immediately after reading. Gitleaks `RuleID` values are
  emitted as stable SHA-256 labels; exact exceptions match the upstream ID.

## Project policy

A project can configure its guardrails in a marked `preflight` section of the same
context file that holds its `project` settings (`AGENTS.md`, or the file it links to).
The section is a fenced JSON block between `<!-- advanced-harness:preflight:start -->`
and `<!-- advanced-harness:preflight:end -->`. Its schema is `version: 1` with optional
`checks`, `forbiddenGlobs`, `prodGlobs`, `testGlobs`, and `allowlistPath`; unknown keys
are rejected at every level. [Configuration](configuration.md#preflight-policy) gives the
full schema and the glob rules.

- **Absent section:** preflight uses built-in check behavior. Nothing is inferred or migrated.
- **Trusted ref only:** the effective policy is read from `refs/remotes/origin/HEAD`
  (see the trust model above). Edits in the worktree never take effect until they reach it.
- **Invalid worktree policy:** an invalid `preflight` section in the worktree is reported as
  `warn` (`policy` result: "does not apply") and never takes effect.
- **Invalid trusted policy:** an invalid `preflight` section at origin/HEAD makes all checks
  inconclusive (`exit 2`).
- **Context files fail closed, even with `--base`:** the worktree context file and the trusted
  context file are read whether or not `--base` is given. If the worktree context file cannot
  be located or read (a symlink or junction, including a dangling one; a non-regular file; a
  file over 1 MiB; or an unreadable file), or the trusted file is unreadable, non-regular, or
  over 1 MiB, every check is inconclusive (`exit 2`). This is a change from before, when
  `--base` skipped the context read and such files did not affect the run. An absent linked
  context file is not a read error: without `--base` it makes base resolution inconclusive,
  and with `--base` a trusted policy that the worktree no longer records is reported as removed (`warn`).
- **Base ref:** the policy has no base-ref key. The base ref stays `baseBranch` in project
  context, or `--base` when given.
- **Configurable checks:** only `path-policy` can be enabled or disabled, or given a
  [check severity](glossary.md#workflow-and-tracking) of `block` or `warn`. The fixed checks
  (`changeset`, `base-context`, `policy`, `secret-scan`, `worktree-boundary`) cannot be
  disabled or downgraded. An unknown check id is an error that lists the configurable ids.
- **Severity:** a `block` may become `warn`, or a `warn` may become `block`, after the
  check runs. `pass` and inconclusive results never change.
- **Disabled checks** are skipped and listed in the `policy` result.
- **Forbidden globs:** `forbiddenGlobs` with `add` extends the built-in path list; `replace`
  checks only the listed globs. `replace` is flagged in the setup preview.
- **Preflight allowlist:** `allowlistPath` is resolved in the worktree and checked for safe
  location: links and junctions are refused at any level, the file must be regular and at
  most 1 MiB, and its real path must stay inside the worktree. A missing file is evidence
  (not present; no exceptions apply). The entry format belongs to BH-068.
- **Recorded but not enforced:** a recorded key that no active check consumes is reported as `warn`.
  `prodGlobs` and `testGlobs` wait for BH-070, and `allowlistPath` waits for BH-068.
- **The `policy` result** always appears. Its evidence gives the source (trusted ref or none),
  disabled checks, severity overrides, any worktree difference, and keys recorded but not enforced.

A policy changes what preflight checks and how it reports them. It is evidence
configuration, never approval: the human still approves publication.

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
and a `run(context)` that receives the worktree, changeset, and read-only effective
`policy` and returns a status, evidence lines, and optional numeric metrics. A thrown
error becomes `inconclusive`. A check that a project may configure sets
`policy: { configurable: true }`; `policy.consumes` lists the policy keys it enforces, so
unconsumed keys are reported as recorded but not enforced. Only checks marked configurable can be named in a
project policy. The id `policy` is reserved for the built-in policy result; a registered check
with that id makes the run inconclusive. The built-in `changeset` and `base-context` checks summarize the
changeset and block unverified project context modifications; guardrail checks
(BH-067..BH-071) plug in alongside them.
