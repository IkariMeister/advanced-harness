# ADR: Preflight Scope, Redaction, and Secret Scanning

**Status:** Proposed\
**Date:** 2026-11-09\
**Project:** Advanced Harness\
**Decision scope:** The preflight changeset and its sensitive-path and secret findings.

## Context

Preflight needs to inspect the complete net task diff and working changes while
keeping secret payloads out of terminal output, JSON, errors, and metrics. Scope,
redaction, exceptions, and completion accounting must have one owner.

## Decision Drivers

1. Inspect the actual proposed net change and current worktree state.
2. Keep secret text out of user-facing results and diagnostics.
3. Make incomplete scans explicit rather than treating them as clean.
4. Keep path policy configurable without weakening defaults silently.

## Considered Options

### A. Scan the full working tree with one mandatory external scanner

This includes unrelated or ignored files and makes preflight depend on an
installed tool. It does not match the publish scope and is rejected.

### B. Let preflight own scoped input and redaction, with optional Gitleaks and fallback (chosen)

Preflight builds the scoped payload, uses Gitleaks where its stdin/report contract
is available, and otherwise uses a built-in high-confidence detector only when
Gitleaks is absent. This preserves operation without the optional tool while
reporting that detector coverage can differ.

## Decision

Preflight owns scope collection, path policy, redaction, rule exceptions, and
completion metrics. It collects the merge-base-to-HEAD net diff (without scanning
intermediate commits), staged, unstaged, and nonignored untracked changes. A shared
bounded, content-free Gitleaks capability probe is used by preflight and doctor.
When Gitleaks is absent, preflight uses a built-in high-confidence detector;
coverage may differ between backends. Added payload is passed on shell-free stdin.
Gitleaks uses the repository-pinned default-rule config from a neutral working
directory with all `GITLEAKS_*` variables removed. It has a fixed timeout and a
4 MiB aggregate input limit. Empty payload skips its scan subprocess. Added blank
lines are retained, and contiguous added-line runs are scanned separately by file
and origin. Diff extraction disables textconv and external diff; rename extraction
includes both old and destination paths so findings use destination line numbers.
Only sanitized rule, location, and a redaction marker may be reported. Invalid,
unusable, failed, or malformed scanner results are inconclusive.

The baseline path rules and justified exceptions are loaded from the explicit
`--base` commit, or `refs/remotes/origin/HEAD` when base comes from project
context, not candidate worktree files. Changes to either policy
file in the candidate changeset block pending review. Explicit programmatic policy
options take precedence. Exceptions match an
exact normalized path and rule with a trimmed nonblank justification and do not
alter path policy. Invalid policy is rejected before checks or secret scanning. Custom
checks cannot be combined with configured policy or explicit policy overrides.
Gitleaks rule IDs are converted to stable SHA-256 labels for output; exception
matching hashes the supplied exact upstream rule ID using the same mapping.

## Consequences

**Positive:** Secret contents are not included in user-facing diagnostics, and
one component defines scope, exceptions, and completion metrics.

**Negative:** Gitleaks and the built-in detector can have different coverage.
The scanner installation and report contract must be validated at runtime.

**Neutral:** Gitleaks remains optional. The path list and exact exception entries
are supplied through preflight configuration; exceptions do not alter path policy.

## Adoption

The accepted implementation scope adds project policy loading, scanner isolation,
added-line collection and completion handling, regression coverage, and updated
preflight/configuration/doctor documentation. Non-text changes remain inconclusive
and identify affected paths without exposing payload text. Rollback does not modify
machine configuration or install Gitleaks.

## Reconsideration

Revisit if Gitleaks changes its supported stdin/output interface, or observed
false-positive/false-negative rates justify a different fallback or scope.

## References

- [Preflight guide](../preflight.md)
- [Global connections and project context](../configuration.md)
- [Gitleaks command and report documentation](https://github.com/gitleaks/gitleaks/blob/master/README.md#usage)
