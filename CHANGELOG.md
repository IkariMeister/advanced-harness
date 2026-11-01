# Changelog

All notable changes to Advanced Harness are listed here. Versions follow the
process in [docs/releasing.md](docs/releasing.md); `main` carries a `-dev`
version between releases.

## Unreleased (0.2.0-dev)

### Added

- Claude Code host support (BH-026, #77) and explicit per-role model selection (#70).
- OpenAI Codex Desktop support, with install and update gated pending strict
  per-role isolation (#45); live model list discovery for Codex role prompts (#113).
- Antigravity explicit per-role runtime tier selection (#109).
- Live OpenCode model catalog and per-host model support reporting (#70).
- Sensitive-path and destructive Git guardrails across hosts (BH-036, #102, #105),
  with a host validation checklist.
- Lead bounded delegation triggers and a four-state status contract (BH-035, #112).
- GitHub issue startup for workflows (#108).
- Harness scratch state kept in the local `.git/info/exclude` (#111).
- Additional required project gates recorded by setup (BH-004).
- Defined, created and surfaced shared worktree and memory locations.
- Sandboxed CLI smoke suite, run in CI on Ubuntu and Windows.
- Architecture decision records (#100, #114) and the design integration
  validation checklist (#98).
- Release process: `-dev` versions on `main`, this changelog, a release checklist,
  CI on `release/**` branches and a tag/version check on `v*` tags (BH-044, #116).
- Release-tag checkouts compare with the newest `v*` release tag during
  `harness:update`; `harness:doctor` prints the checkout version (BH-044, #116).

### Fixed

- `harnessVersion` stamped on install receipts for all hosts (#82).
- `harness:uninstall` removes Claude Code and Antigravity installs.
- Antigravity install confirmation defaults to no (#81); config conflicts are
  reported as an actionable error (#104); merge-guard hook path is no longer
  quoted (#101); `run_command` enabled for External, Reviewer and QA (#95).
- `harness:install` and `harness:update` prompt for a single host.
- Install reports an incomplete install when a declined role leaves nothing to write.
- Shared locations that resolve into the checkout through links are rejected.
- Design server default scoped to its kind; invalid MCP URLs are re-prompted (#103).

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
