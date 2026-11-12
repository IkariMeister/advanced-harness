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
- Git rename detection (`-M`) is enabled for committed net changes, staged changes,
  and unstaged changes. Rename destinations are scanned and checked by path policy.
- A deleted file has no contents, which is distinct from a present zero-byte file.
- Entries also record `kind`: `file`, `symlink` (contents are the link target, read
  without following it),
  `submodule` (gitlinks or nested git repositories have no contents), or `other`
  (no contents). Contents are read in full with no size limit; limits on large
  files are left to the guardrail checks (BH-067..BH-071) that consume them.
- Text entries include added lines and their target line numbers, grouped by
  committed net diff, staged, unstaged, and untracked origin.
  These target coordinates are 1-based new-file snapshot line numbers. Line-scoped
  allowlist entries must include both `line` and `origin`; an exception for a staged
  line cannot suppress a committed, unstaged, or untracked finding at the same number.
- Added-line extraction uses Git's literal path mode, disables external diff and
  textconv, and binds each diff to exact repository paths. For detected renames,
  extraction includes both old and destination paths; the regression test verifies
  destination line numbers. Binary or otherwise undecodable diffs are marked
  incomplete. Eligible text is still scanned; a finding blocks even when another
  entry is incomplete, and otherwise the check is inconclusive. Affected paths are
  escaped, bounded, and summarized with counts. Empty untracked files have no added
  lines. Untracked symlinks are inspected with `lstat`/`readlink` only, never followed,
  and make secret scanning inconclusive.
- The supported Git contract requires `diff --name-status -z -M`, literal pathspecs,
  `--no-ext-diff`, `--no-textconv`, zero-context patches, `merge-base`, `ls-tree`,
  `ls-files`, and `cat-file`. If a required command or option is unavailable, the
  changeset is inconclusive.
- The changeset contains all file bytes, but secret-scanner input is bounded to
  4 MiB aggregate UTF-8 payload. The cap is checked before either scanner is
  selected or invoked; oversized input is inconclusive. Added blank lines are retained, and
  the scanner receives separate contiguous runs per file and origin. Empty input
  skips the scanner subprocess. Gitleaks capability probing and every scan run share
  one fixed 10-second monotonic aggregate deadline. Metrics distinguish an unrun scanner from an unavailable backend and
  report bounded affected-path counts.
- `path-policy` blocks configured sensitive paths (including rename destinations)
  and skips deletions. The default glob list is case-insensitive and project
  replaceable. Rule exceptions require an exact path/rule pair and a trimmed,
  nonblank justification; optional positive `line` narrows an exception to one line.
  Omitting `line` preserves whole-file path/rule entries. Exceptions never change
  path policy. On Windows the native Gitleaks executable (`gitleaks.exe`) is required;
  shell wrappers are not used.
- Default path globs: `**/.env*`, `**/id_rsa*`, `**/.DS_Store`, `**/keys/**`,
  `**/keystores/**`, `**/*.key`, `**/*.pem`, `**/*.p12`, `**/*.pfx`,
  `**/*.jks`, `**/*.keystore`, `**/build/**`, and `**/dist/**`.
  Glob matching is case-insensitive after converting `\\` to `/`. `*` matches
  zero or more characters within one path component; `?` matches exactly one
  character within one component. `**` matches any characters including `/`, and
  `**/` matches zero or more directory components, so `**/*.pem` includes both
  `root.pem` and `certs/root.pem`. By contrast, `*.pem` matches root-level files
  only. Brackets and braces are literal characters, not character classes or
  alternation syntax: `file[1].pem` matches that bracketed name literally.
  Preflight reads `.harness/preflight.json` (`forbiddenPathGlobs` and
  `gitlinkAcknowledgements`) and `.harness/preflight-allowlist.json` from
  `refs/remotes/origin/HEAD`, independently of `--base`. It never reads
  candidate working-tree policy contents. Changes to either policy file in
  the candidate changeset block pending review. Programmatic `runPreflight`
  callers can explicitly supply `sensitivePathGlobs` and `secretExceptions`; these
  caller-supplied values take precedence over the trusted files. Projects provide justified exceptions in
  `.harness/preflight-allowlist.json`, a JSON array of entries containing `path`,
  `rule`, and a nonblank `justification`, optionally with a positive `line`;
  programmatic callers use
  `secretExceptions`. Project policy is validated after resolving the changeset
  base and before check execution or secret scanning.
  Custom `checks` can run while configured project policy is present; they cannot be
  combined with explicit policy overrides. Trusted policy files are still loaded and
  validated, including the allowlist shape when programmatic exceptions override its
  values. Exceptions are normalized for separators and a leading `./`,
  then match the exact path/rule pair. Their trimmed justification is never shown;
  the full normalized path is retained for matching, while display escapes control
  characters and shortens very long paths. Metrics report only how many findings
  were excepted. For Gitleaks findings, the
  displayed rule is a stable SHA-256 label; exceptions use the exact upstream
  Gitleaks `RuleID` so arbitrary report identifiers are never emitted.
- Secret scanning uses the shared bounded scanner probe described in
  [ADR-007](adr/0007-preflight-scope-and-redaction.md). Gitleaks uses the checked-in
  `src/preflight/gitleaks.toml` default-rule config, a private temporary working directory,
  and an environment with all `GITLEAKS_*` variables removed. Scanner payload is
  passed on stdin; output is reduced to sanitized rule/location records. If
  Gitleaks is absent, a documented built-in high-confidence detector runs. An
  installation must be Gitleaks 8.30.1 or newer. An installed but unsupported or
  unusable probe is inconclusive; only an absent executable selects fallback. The
  executable is resolved from absolute `PATH` entries. On Windows, quoted and
  unquoted absolute directories are supported and only native `gitleaks.exe` is
  selected; the resolved executable path is invoked directly. Metrics distinguish
  Gitleaks, built-in, and unavailable backend states.
- Gitleaks is invoked as `<resolved-executable> stdin --report-format json --report-path
  <temporary-report> --redact=100 --no-banner` with the pinned config argument;
  JSON findings use `RuleID` and `StartLine`. Exit code 1 is accepted only when the report parses as valid
  nonempty findings, and exit code 0 only with an empty report. The temporary
  report directory is removed after all runs finish or fail, including
  incomplete scans and subprocess errors. Gitleaks `RuleID` values are
  emitted as stable SHA-256 labels; exact exceptions match the upstream ID.
- The optional Linux x64 8.30.1 release asset is pinned to SHA-256
  `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`; downloaded
  archive bytes must pass this digest check before extraction.

## Project policy and revision authority

The repository-specific scanner policy is stored in `.harness/preflight.json` and
`.harness/preflight-allowlist.json`. Preflight loads these files from the local
`refs/remotes/origin/HEAD` regardless of `--base`; `--base` selects only the changeset
comparison revision. That trusted revision is the policy authority for the run. A candidate changeset that edits, renames, or
deletes either policy file is blocked by `policy-integrity`; land and review the
policy change in the trusted base first, then run preflight against that revision.
The task branch cannot grant itself a new scanner exception or weaken its path rules.

Gitlink coverage acknowledgements are configured only in trusted
`.harness/preflight.json`. For a changed gitlink use a normalized repository-relative
path, exact IDs, and a nonblank justification. An addition omits `oldId`:

```json
{"gitlinkAcknowledgements":[{"path":"vendor/example","oldId":"<old commit ID>","newId":"<new commit ID>","justification":"Reviewed upstream contents; source unavailable to scanner."}]}
```

```json
{"gitlinkAcknowledgements":[{"path":"vendor/example","newId":"<new commit ID>","justification":"Reviewed upstream contents; source unavailable to scanner."}]}
```

The exact path and IDs must match. Output identifies matched gaps and keeps the scan
marked incomplete. Exit 0 is allowed when every remaining gap is a valid trusted
acknowledgement and there are no findings or other gaps; acknowledged coverage is
visibly labeled. Dirty or uninspectable nested content cannot be acknowledged.
Acknowledgements cannot suppress findings or other incomplete paths. The former
`--ack-gitlink` option is rejected with migration guidance. Policy edits in the
candidate changeset remain blocked until reviewed and present at trusted `origin/HEAD`.

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
  errors (such as conflict or invalid shape) are inconclusive (`exit 2`). Malformed,
  unreadable, or otherwise invalid trusted policy JSON makes policy-dependent checks
  inconclusive even when explicit programmatic path-glob or exception overrides are
  supplied, because trusted gitlink acknowledgements still require validation.
  Independent checks continue to run. Explicit exception values replace trusted
  entries only after the trusted allowlist has been read and its JSON shape validated.
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

### Exit-code precedence

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

## Trusted acknowledgement evidence and status

Trusted policy is resolved from the local `refs/remotes/origin/HEAD`; `--base`
selects only the changeset comparison base. Gitlink acknowledgement evidence
identifies the resolved trusted policy commit. Gitlink commit IDs accept exactly
40 or 64 hexadecimal characters and are normalized to lowercase. Omitting
`oldId` only acknowledges an added gitlink. The
`secret-scan.acknowledgedPaths` metric records acknowledged paths and drives the
exit code and human verdict. Custom checks still run if trusted policy is invalid,
while checks that depend on that policy report the policy error. Nested gitlink
status is probed once per path per changeset collection with repository environment
overrides removed; probe timeout or failure leaves nested content dirty/incomplete.