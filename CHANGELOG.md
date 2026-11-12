# Changelog

All notable changes to Advanced Harness are listed here. Versions follow the
process in [docs/releasing.md](docs/releasing.md); `main` carries a `-dev`
version between releases.

## Unreleased

### Added

- `MEMORY.md` pruning during learning review (BH-077, #216): add pruning candidate proposals
  at end-of-task learning review across three kinds: redundant (covered by rules in `AGENTS.md`
  or `AGENTS.personal.md`), contradicted or superseded (by newer entries or rules), and
  obsolete (refers to issues, branches, or files that no longer exist, with remote evidence
  relayed through Lead from External; references with `unknown` status or check errors are never proposed).
  Learnings leave `MEMORY.md` upon approved promotion to any tier (`AGENTS.md` or `AGENTS.personal.md`) or on discard.
  Kept entries are marked with a visible `reviewed-keep:<kind>:<evidenceKey>` marker so they are not re-proposed
  without a new reason. Operators remain the sole serialized writer of `MEMORY.md`; declining or cancelling writes
  nothing. Extends shared rule validation to enforce non-empty, single-line, and 2000-character limits on promotion.
- Personal project rules destination (BH-076, #208): add private, permanent storage for learnings
  in `AGENTS.personal.md` stored beside `MEMORY.md` in the project data directory (derived from `memoryPath`),
  never committed or copied into worktrees. Learning review gains a fourth disposition, "Apply only to me".
  Order of precedence is `Current Human Decision > AGENTS.md > personal rules > MEMORY.md`.
  Includes contradiction detection between personal rules and `AGENTS.md` with a single human decision,
  and exclusion from promotion candidate lists and memory pruning.
- `worktree-boundary` preflight check (BH-067, #182): enforces that preflight is run in an
  isolated task worktree under `worktreeDirectory`. The default pipeline now blocks canonical checkouts
  (where `--git-dir` resolves to the same path as `--git-common-dir`), unconfigured projects (missing
  `worktreeDirectory`), worktrees outside `worktreeDirectory`, and modifications that change `worktreeDirectory`
  away from the trusted ref `refs/remotes/origin/HEAD` or when the trusted ref is unavailable (check status `block`).
  Because `exitCodeFor` prioritizes `inconclusive` (`exit 2`) over `block` (`exit 1`), a missing trusted ref with
  `--base` omitted yields overall exit 2 (due to `base-context`), while passing `--base <ref>` yields exit 1 (see
  [docs/preflight.md](docs/preflight.md) for exit-code precedence). Supports optional `--task <key>` to block on
  branch mismatches or detached `HEAD`. Note that `defaultChecks` now includes `worktreeBoundaryCheck`.
- `harness:preflight` (BH-066, #181): a pluggable preflight check runner over the task
  worktree changeset (including `changeset` and `base-context` checks), with JSON and human output
  and exit codes 0 pass, 1 blocked, 2 inconclusive. When `--base` is omitted, `base-context` verifies
  the project context and `baseBranch` against the local trusted ref `refs/remotes/origin/HEAD`
  (no fetch); a missing trusted ref or unreadable context is inconclusive (exit 2). See [docs/preflight.md](docs/preflight.md).

### Changed

- The canonical checkout of an application repository receives only remote updates
  (#172, [ADR-004](docs/adr/0004-canonical-checkout-remote-updates-only.md)). Operator
  inspects it read-only before task bootstrap and reports and waits for a human decision
  if it is dirty, mid-operation, off the base branch, or detached. When Lead relays the
  step, External runs `git fetch` and then `git merge --ff-only` (still ASK; no new allow
  rule), and reports and waits instead if the base is ahead of or diverged from origin.
  Untouched canonical changes no longer let bootstrap proceed, and a failed fetch no
  longer falls back to branching from the local base. The rule applies only to projects that
  use task worktrees; pinned consumer harness checkouts are unchanged.
- Claude Code: Operator now has Bash for local Git and task worktree bootstrap, so
  `/start-issue` can create the worktree there (#200, [ADR-005](docs/adr/0005-claude-code-operator-bash.md),
  Proposed). Operator's `git fetch --upload-pack` and `-u` denies become project settings
  deny rules for every session. Its `git push`, `git pull`, `git clone`, and `gh` denies are
  advisory on Claude Code: instruction only, not enforced. The Operator exception applies only
  while its shell denies exactly match the ADR-005 list; any missing or extra deny withholds
  Bash and is reported as unsupported. Implementer, Reviewer, QA, and Lead
  still have no Bash. If Operator's Bash is unavailable or declined, bootstrap stops for a human
  to create the worktree or cancel.
  Upgrade: run `harness:update --host claude-code`. Until you do, `harness:doctor` reports
  `operator.md` and `CLAUDE.md` as outdated and `.claude/settings.json` as missing the new
  fetch deny rules.
- Codex Operator and External role profiles now run with `sandbox_mode = danger-full-access`,
  derived from the role sources, so `git add`, `git commit` and `gh` are expected to no longer be
  blocked by the workspace-write sandbox (motivation recorded in #218; not verified by a live run) (#218, [ADR-006](docs/adr/0006-codex-operator-external-full-access.md),
  Proposed). Lead stays read-only and on request. The destructive-command rules remain
  installed, but their enforcement for full-access roles is unverified. Existing installs must
  run `harness:update --host codex`. Manual smoke was waived.

### Fixed

- Codex role processes (listing, launch and resume) now run with Codex plugins disabled,
  so plugin-provided MCP servers no longer make every role launch fail with "invalid
  transport" (#209). If listing the MCP servers fails, the launcher now names the role and
  Codex's reason and starts nothing.

## v0.3.0 — 2026-11-08

Milestone "Shared Skills": reusable procedure skills that roles share across hosts.

### Added

- Procedure skills: canonical, versioned skills under `skills/` compile to host
  skill artifacts for OpenCode, Claude Code, Antigravity and Codex, in their own
  `harness-procedure` namespace (#137, #165). Install, update and uninstall deploy
  them for OpenCode, Claude Code and Antigravity, with receipts, protection for
  files you customized, and preservation of files another owner still needs. Codex
  procedure skills are compiled only, not deployed (#138, #173).
- `harness:doctor` checks canonical and installed procedure skills (presence,
  frontmatter and role scoping) per host, and reports host role-scoping limits as
  advisory. A support matrix documents which hosts scope skills by role (#139, #180).
- Documentation skills from ADR-001: `documentation-impact`, `adr-authoring`,
  `technical-documentation`, `documentation-validation` and `documentation-review`,
  plus bounded offline documentation checks in CI (`npm run docs:check`) (#124, #189).
- QA validation skills from ADR-002: `unit-tests`, `static-analysis` and
  `evidence-collection`, shared by Implementer, Reviewer and QA (#125, #188).
- `meeting-task-extraction` skill for Lead and Planner: extracts tasks from pasted
  or exported meeting transcripts (for example Notion or Gemini notes), treats the
  transcript as untrusted data, marks inferred tasks and missing owners or dates,
  and creates nothing without per-task approval (#175, #177).
- `/document-agents` workflow command: generates or updates root or module-scoped
  `AGENTS.md` files. The human picks the scope and mode, every proposed statement is
  labeled verified, inferred or unknown, and nothing is written before the exact diff is
  approved. It uses the shared documentation procedure skills and Reviewer's independent
  check, and adds no Documentation role (#76, #196).
- Role contracts now assign documentation ownership (ADR-001): Planner owns ADRs and
  documentation impact, Implementer updates affected docs, Reviewer checks their
  accuracy and reports each check as re-run or judged from evidence only (ADR-002),
  and Lead tracks the documentation and approval state (#122, #142).
- OpenAI Codex install, update, doctor and uninstall at global scope: each child
  role runs as its own `codex exec` process with a source-derived profile, started
  by Lead through a launcher that re-applies the role settings on every launch and
  resume, with your host permission at the Codex Desktop prompt for each launch. Uninstall removes only the Lead block
  from a shared `AGENTS.md` and reverses only the
  harness's own `config.toml` edits (#45, #153, #154).
- `harness:doctor` reports each resolved worktree and shared `MEMORY.md` location
  and its source, and fails on invalid or conflicting settings. Missing settings
  are reported without failing (#176, #193).
- ADR status lifecycle (`Proposed`, `Accepted`, `Rejected`, `Superseded`), an ADR
  template, and a project glossary (`docs/glossary.md`). ADR-001 and ADR-002 are
  Accepted; ADR-003 stays Proposed (#121, #141, #136).

### Changed

- All worktrees of a repository now get the same default worktree and shared
  `MEMORY.md` locations. Paths under your home directory are saved as `$HOME/...`,
  and settings saved that way no longer record `projectRoot`. Harness checkouts
  older than this change reject such settings, so update them before committing
  portable settings. Existing absolute settings keep working (#176, #193).
- `harness:update` no longer asks about valid saved locations. Use
  `--change-shared-locations` to change them (#176, #193).
- Role contracts tell agents to read these locations from project context on every
  compiled host, and to ask only when a value is missing, invalid, or conflicting
  (#176, #193).
- Global project defaults now save to `~/.config/advanced-harness/project-defaults.json`
  instead of the OpenCode config directory. The old file keeps working as a read-only
  fallback. Run `harness:setup --global`, type `migrate`, then `save` to move its values; the
  old file is never edited or deleted (#190, #191).
- QA's instructions now state that `git` and `gh` shell commands are denied for QA,
  including read-only ones, and Lead passes the Git context Operator reported
  (branch, HEAD, changed files, diff summary) when delegating to Reviewer or QA.
  QA's permissions are unchanged (#169, #195).

### Fixed

- Procedure skills with multiline descriptions now get valid YAML frontmatter on
  every host (#166, #192).
- Committed project settings no longer count as belonging to "another checkout"
  in other worktrees, and a task worktree under the configured worktree parent no
  longer fails validation (#176, #193).
- `harness:uninstall` for Claude Code and Antigravity no longer stops when you
  edited `CLAUDE.md` or `AGENTS.md` outside the harness block. It removes only the
  block and keeps your edits. An edited or missing block still stops uninstall with
  no writes (#84, #178).
- Uninstall no longer drops `CLAUDE.md` edits that a later update had recorded as
  installed content. They used to survive only in the private backup (#84, #178).

### Upgrading from v0.2.x

Check out the tag (`git fetch --tags origin && git checkout v0.3.0`), run
`npm ci`, then `npm run harness:update` for each installed project. Update
previews the new procedure skills and other changes before writing and keeps your
models and customizations. If you have global project defaults in the OpenCode
config directory, run `npm run harness:setup -- --global`, type `migrate`, then `save` to
move them.

## v0.2.3 — 2026-11-04

Patch release on the 0.2 line (#170).

### Fixed

- `harness:update` no longer stops on a rule the harness owns when the current
  policy changes its effect, such as the Operator `git fetch *` deny from v0.2.0
  and earlier on installs with per-rule receipts. The preview flags the change
  (`! effect change`), and it applies only after the final `update` confirmation.
  Rules you added or edited, rules another source still needs, and required
  denials still block. Run `harness:update` to apply (#167, #168).
- A global or project OpenCode directory where `opencode.json` and
  `opencode.jsonc` are a symlink to each other no longer requires `--config`:
  the regular file is the target and the link is kept (#167, #168).

## v0.2.2 — 2026-11-03

Patch release on the 0.2 line (#161).

### Fixed

- OpenCode installs that started from a legacy (v1) receipt can update and
  uninstall again. `harness:update` offers a legacy permission migration
  (type `migrate`) that replaces older legacy rules the current policy changes,
  such as the Operator `git fetch *` deny, and records hand edits to legacy
  permission arrays so uninstall no longer reports them as concurrent edits.
  Uninstall points to the migration when it finds stale legacy evidence.
  Run `harness:update` and type `migrate` to apply (#160, #162).

## v0.2.1 — 2026-11-03

Patch release on the 0.2 line (#149).

### Added

- Claude Code global-scope install, update, doctor and uninstall into
  `~/.claude` (read by the CLI and Claude Code Desktop) (#146, #152).

### Fixed

- `/review-pr` and `/address-pr-feedback` now include Reviewer's risk-tiered
  review rubric (tiers, lenses, summary and finding formats), copied from
  `agents/reviewer.md` when commands are installed. Lead previously could not
  see the rubric and stopped before assigning a provisional review tier.
  Run `harness:update` to apply (#156, #157).
- Operator may run `git fetch` to refresh the base before creating a worktree,
  so OpenCode bootstrap no longer stops on a denied fetch;
  `--upload-pack` (including any `--upl…` abbreviation) and, defensively,
  `-u` (`--update-head-ok` for fetch) stay denied, and
  pull/push/clone remain External's.
  Run `harness:update` to apply (#144, #151).
- `harness:doctor` accepts `--scope <global|project>` and reports invalid,
  duplicate or incomplete options instead of a generic "Verification
  inconclusive" message (#145, #150).
- OpenCode `harness:install` and `harness:update` no longer exit non-zero when
  the post-save runtime verification is inconclusive; they warn and point to
  `harness:doctor`. Definite readiness failures still exit 1 (#143, #148).

## v0.2.0 — 2026-11-01

Milestone: Security Guardrails, Model Discovery & Core Role Contracts.

### Added

- Sensitive-path and destructive Git guardrails across hosts (BH-036, #102),
  with OpenCode and Codex gap fixes and a host validation checklist (#105).
- Per-role model selection and live model discovery (BH-043): live OpenCode model
  catalog and per-host support reporting (#106), Claude Code explicit per-role
  models (#107), Antigravity per-role runtime tiers (#109) and Codex live model
  list discovery (#113).
- Lead bounded delegation triggers and a four-state status contract (BH-035, #112).
- Risk-tiered PR reviews with the 4R lens taxonomy for the Reviewer role
  (BH-033, #115).
- Harness scratch state kept in the local `.git/info/exclude` (BH-038, #111).
- Claude Code host support (BH-026, #77).
- OpenAI Codex Desktop support, with install and update gated pending strict
  per-role isolation (#78).
- GitHub issue startup for workflows (#108).
- Setup records additional required project gates such as Spotless and Detekt
  (BH-004, #90).
- Shared worktree and memory locations are defined, created and surfaced (#93).
- Sandboxed CLI smoke suite, run in CI on Ubuntu and Windows (#79).
- Architecture decision records (#100, #114), the design integration validation
  checklist (#98) and clarified evidence publication authorization (#87).
- Release process: `-dev` versions on `main`, this changelog, a release checklist,
  CI on `release/**` branches and a tag/version check on `v*` tags. Release-tag
  checkouts compare with the newest `v*` tag during `harness:update`, and
  `harness:doctor` prints the checkout version (BH-044, #117).

### Fixed

- `harnessVersion` stamped on install receipts for all hosts (#86).
- `harness:uninstall` removes Claude Code and Antigravity installs (#83).
- Antigravity: install confirmation defaults to no (#85), config conflicts are
  reported as an actionable error (#104), the merge-guard hook path is no longer
  quoted (#101) and `run_command` is enabled for External, Reviewer and QA (#99).
- `harness:install` and `harness:update` prompt for a single host (#89).
- Design server default scoped to its kind; invalid MCP URLs are re-prompted (#103).

### Upgrading from v0.1.0

Check out the tag (`git fetch --tags origin && git checkout v0.2.0`), run
`npm ci`, then `npm run harness:update` for each installed project. Update
previews prompt, permission and guardrail changes before writing and keeps your
models and customizations.

## v0.1.0 — 2026-10-27

Initial release: a host-neutral eight-role engineering workflow (Lead, Operator,
External, Researcher, Planner, Implementer, Reviewer, QA) with conversational
human approvals and receipt-backed lifecycle tooling.

### Host support

- OpenCode V2 and Google Antigravity: artifact compilation and native
  install, update and doctor.
- Claude Code, Codex and Cursor: deterministic artifact compilation only.

### Added

- Multi-host foundation: `--host` CLI, coexistence, receipts and model presets
  (BH-024, #41); cross-host skill/command and MCP config translator (BH-025, #42);
  native Google Antigravity support (BH-027, #44).
- Safe installer upgrades and permission reconciliation (BH-006, #12); effective
  runtime tools and permissions (BH-009, #15); macOS and LiteLLM portability
  (BH-011, #17); setup UX and discovery (BH-013, #19); per-agent tool availability
  (BH-019, #25).
- `harness:update` (BH-020, #26) and `harness:uninstall` (BH-021, #27).
- Interruption, resume and uncertain-operation handling (BH-010, #16); shared
  memory and bootstrap workflow (BH-012, #18).
- Workflow commands `/start-issue`, `/review-pr`, `/report-defect`,
  `/assess-debt`, `/grill-me` (BH-017, #23) and `/address-pr-feedback`
  (BH-030, #48), installed by `harness:install` (BH-032, #57).
- `SECURITY.md` and vulnerability disclosure policy (BH-039, #67).

### Fixed

- CLI argument parsing (#55), uninstall `--scope` discovery (#58) and duplicate
  permission rule handling (#68).
