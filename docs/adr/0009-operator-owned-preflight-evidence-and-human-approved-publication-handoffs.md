# ADR: Operator-Owned Preflight Evidence and Human-Approved Publication Handoffs

**Status:** Proposed\
**Date:** 2026-11-14\
**Project:** Advanced Harness\
**Decision scope:** Ownership, freshness, and interpretation of preflight evidence and publication handoffs. This does not change preflight JSON identity schema or authorize publication.

## Context

Preflight produces Git-backed results but no human identity or approval. Reviewer and
QA do not own local Git; External owns remote Git and publication. Requiring every role
to rerun creates duplicate state and fails when a role lacks the required shell.
Conversational handoff can be stale or incomplete, so freshness checks and honest
capability reporting are essential.

## Decision drivers

1. Preserve role ownership and avoid duplicated Git-backed execution.
2. Keep evidence distinct from human approval and retain explicit freshness checks.
3. Report missing or denied execution honestly without role/tool substitution.
4. Avoid implying atomicity, runtime enforcement, or identity guarantees absent from the schema.

## Considered options

### A. Every role reruns preflight

Rejected: duplicates Git state, conflicts with Reviewer/QA ownership, and does not
provide a usable route when their shell is unavailable.

### B. Controller, token, or schema redesign

Rejected for this scope: it would introduce an enforcement or identity system not in
the approved conversational workflow and exceed the limited feedback fix.

### C. Operator-owned conversational handoff (proposed)

Chosen for this proposal: Operator runs from the confirmed harness checkout, targeting
the task worktree, and relays exact command/result/status plus worktree, branch, HEAD,
and working-change identity. Reviewer and QA assess it. External verifies remote state
against the expected prior remote head immediately before an authorized push, then
checks the remote head against approved handoff HEAD after the write. Missing tool
access is reported and escalated; no alternate role/route is used. A human may run the
exact command and provide attributed output or explicitly grant a scoped conversational
exception. The JSON `approved` field is an automated verdict only. Final human
publication approval remains separate. Exceptions quote the human message and name
the current result/state and waived checks; waived is not passed.

## Consequences

The handoff is advisory and non-atomic. Local or remote state may change during
inspection or relay; unexpected state and uncertain writes stop for read-only
inspection, never automatic retry. Static matcher tests do not establish host sandbox
behavior or runtime enforcement. Missing execution is not a fabricated result, and
role prompts do not provide installed documentation by themselves.

## Adoption

The proposed implementation updates source role/command guidance, tests, and
documentation. It does not deploy installed prompts, change services, alter the JSON
identity schema, or publish. Rollback uses the normal approved workflow and does not
require service or machine configuration changes.

## Reconsideration

Reconsider if observed freshness failures persist, the confirmed harness checkout is
unavailable, or an explicitly approved follow-up establishes a need for identity
schema changes. Static tests alone are not runtime evidence.

## References

- Issue #186 and PR #244 feedback
- [Preflight guide](../preflight.md)
- [Glossary](../glossary.md)
- [ADR-001: Documentation ownership](0001-documentation-ownership-through-shared-skills.md)
- [ADR-007: Preflight scope and redaction](0007-preflight-scope-and-redaction.md)
- [ADR-008: Project guardrail policy](0008-project-guardrail-policy.md)
