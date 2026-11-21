# ADR-012: Bind Codex Implementer to a Linked Worktree

**Status:** Proposed
**Date:** 2026-11-20

## Context

Codex role processes run with role-specific sandbox configuration, but the
Implementer also needs a reliable task boundary: it must edit the selected task
worktree and must not resume a thread against another checkout. A caller-selected
working directory alone is insufficient, and a Codex sandbox profile alone does
not prove runtime enforcement on every supported version.

## Decision

Require Implementer launches to provide the exact canonical root of a linked Git
worktree. The launcher validates local Git metadata without accepting inherited
repository-selection overrides. All installed profiles use an empty
`sandbox_workspace_write.writable_roots` baseline. Fresh and resumed Implementer
argv replace it with exactly one validated absolute root; other roles retain the
empty list. New Implementer thread records bind the canonical worktree and linked Git
administration identity. Missing, legacy, malformed, or mismatched records fail
before starting Codex.

## Consequences

Implementer cannot be started from the main checkout or a subdirectory. Existing
legacy Implementer threads require a new task rather than resume. The boundary is
configuration and launcher validation, not a universal guarantee of Codex
filesystem isolation; an isolated Windows runtime smoke is required to establish
actual behavior for a tested Codex version.

## Reconsideration

Revisit if Codex provides a verified, stable per-process worktree boundary that
removes the need for launcher validation, or if the supported Git/Codex versions
cannot provide the required local metadata checks.
