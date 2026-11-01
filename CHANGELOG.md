# Changelog

All notable changes to Advanced Harness are listed here. Versions follow the
process in [docs/releasing.md](docs/releasing.md); `main` carries a `-dev`
version between releases.

## Unreleased

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
