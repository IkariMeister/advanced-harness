# Architecture Decision Records

This directory contains proposed and accepted architecture decisions for Advanced Harness. Each record states its status; a `Proposed` ADR documents a recommendation and does not by itself authorize implementation or change current behavior. ADRs use the terms defined in the [glossary](../glossary.md); define new terms there rather than inside an ADR.

| ADR | Title | Status | Scope |
| --- | --- | --- | --- |
| [ADR-001](0001-documentation-ownership-through-shared-skills.md) | Documentation Ownership Through Shared Skills | Accepted | Documentation ownership and quality assurance |
| [ADR-002](0002-consolidate-agent-responsibilities.md) | Consolidate Agent Responsibilities While Preserving Specialized Reasoning and Independent Review | Accepted | Agent architecture and workflow orchestration |
| [ADR-003](0003-multi-methodology-development-architecture.md) | Multi-Methodology Development Architecture | Proposed | Methodology selection, scope, and governance |
| [ADR-004](0004-canonical-checkout-remote-updates-only.md) | Keep the Canonical Checkout Read-Only Except for Remote Updates | Proposed | Git ownership of the canonical checkout during task bootstrap |
| [ADR-005](0005-claude-code-operator-bash.md) | Give Operator Bash on Claude Code With Advisory Remote-Git Denies | Proposed | Claude Code tool mapping for Operator and its shell deny patterns |

## Status lifecycle

| Status | Meaning |
| --- | --- |
| `Proposed` | Drafted for discussion. The recommendation is not yet the project's decision. |
| `Accepted` | The human accepted the decision. It is the project's current direction. |
| `Rejected` | The human declined the decision. The record stays to explain why. |
| `Superseded by ADR-NNN` | A later ADR replaced this decision. The record stays unchanged apart from its status. |

An ADR starts as `Proposed` and moves to exactly one of `Accepted` or `Rejected`. Only an `Accepted` ADR can later become `Superseded by ADR-NNN`; the superseding ADR goes through the same lifecycle and names the ADR it replaces. Records are never deleted or renumbered.

### Roles

- **Planner proposes.** Planner authors and updates ADRs, as [ADR-001](0001-documentation-ownership-through-shared-skills.md) assigns, and states the decision, the options considered, and the reconsideration criteria.
- **Reviewer checks.** Reviewer checks the ADR independently for accuracy and consistency with the repository before it is put to the human.
- **The human accepts or rejects.** Acceptance is an [approval](../glossary.md#workflow-and-tracking): an explicit human decision in the conversation, under the existing [approval boundaries](../../README.md#human-control-in-the-lead-conversation). No agent accepts an ADR, and acceptance is never inferred from a merged PR, a tool result, or silence.
- **Lead records.** Lead presents the decision, records the human's answer, and tracks it until the record below is merged.

### Recording a decision

A status change is its own change, reviewed and merged like any other. It updates:

1. **The ADR header.** Set `Status`, add `Decided` with the date of the human decision, and add `Decision record` with a link to the PR that records it. A superseded ADR also links to the ADR that replaces it.
2. **This index.** Update the Status column to match the header.
3. **The reason, for a rejection or a deferral.** A `Rejected` ADR states why in its header. An ADR the human decides to leave `Proposed` after review gets a `Pending` line stating the reason and what would change it, so the open status is deliberate rather than forgotten.

Example header for an accepted ADR:

```markdown
**Status:** Accepted\
**Date:** 2026-10-30\
**Decided:** 2026-11-15\
**Decision record:** #NNN\
```

### Accepting a decision is not approving a plan

Accepting an ADR makes the decision the project's direction. It does not change tooling, installed roles, permissions, host configuration, or project defaults, and it does not authorize implementation. Each implementation step still needs its own scoped plan and human plan approval, as the ADR's adoption section describes. Conversely, approving a plan that builds on a `Proposed` ADR does not accept the ADR.

## Revisiting a decision

An ADR is revisited when:

- one of its own reconsideration criteria is met, based on recorded outcomes rather than preference; or
- a milestone closes. The post-milestone ADR review checks each `Proposed` and `Accepted` ADR against its reconsideration criteria and the evidence gathered since the last review, and proposes backlog work or a status change.

Revisiting can lead to a new ADR that supersedes the old one, a minor revision of a `Proposed` ADR, or no change. Changing an `Accepted` decision materially requires a superseding ADR rather than an in-place edit; clarifications that do not change the decision may be edited in place.

## Writing a new ADR

Copy [`template.md`](template.md) to `NNNN-short-title.md` using the next free number, fill it in, and add a row to the index above with status `Proposed`.
