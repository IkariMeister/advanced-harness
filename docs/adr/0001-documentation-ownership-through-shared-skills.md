# ADR: Documentation Ownership Through Shared Skills

**Status:** Proposed  
**Date:** 2026-10-30  
**Project:** Advanced Harness  
**Decision scope:** Documentation ownership, documentation workflows, and quality assurance

## Context

Advanced Harness uses specialized agents to separate orchestration, technical planning, implementation, independent review, repository operations, and external integrations. The project is evaluating selective consolidation to reduce unnecessary delegation, context transfer, latency, and token consumption while preserving clear responsibilities, human approval boundaries, and independent review.

The backlog proposes a workflow for generating and updating repository or module-scoped `AGENTS.md` documentation. This is a useful capability, but it does not require a permanent Documentation agent. Documentation is cross-cutting: it includes ADRs, technical designs, developer guides, operational instructions, API and integration references, user-facing material, agent instructions, and implementation-driven updates.

The agent closest to a decision or change usually has the most authoritative context. Assigning all documentation to Engineer would miss architectural rationale, while relying on each agent's individual habits risks inconsistent quality. A separate documentation agent can help with large efforts, but mandatory delegation adds a handoff even for small changes and does not by itself provide independent review.

## Decision Drivers

1. Keep documentation with the agent that has authoritative subject knowledge.
2. Reduce unnecessary delegation and context reconstruction.
3. Preserve independent validation of accuracy and completeness.
4. Apply consistent conventions across supported hosts.
5. Avoid making documentation a mandatory phase when no material documentation is affected.
6. Preserve human approval for decisions and changes that require it.
7. Support specialized documentation work when its scale justifies it.

## Considered Options

### A. Permanent Documentation Agent

Provides focused ownership and potentially consistent writing. It also adds routine handoffs, can lack implementation or decision context, overlaps Planner and Engineer, and still needs a separate reviewer. Rejected as the default; a temporary documentation context remains an exception.

### B. Engineer Owns All Documentation

Keeps implementation details close to code and minimizes handoffs. It assigns ADRs and other non-implementation content to an agent that may not own the underlying reasoning and provides no independent check. Rejected as a universal model.

### C. Distributed Ownership Without Shared Procedures

Keeps authoring close to the source of truth without another agent, but allows writing and validation practices to drift. Insufficient without shared standards.

### D. Distributed Ownership Through Shared Skills

Assigns documents by subject, provides reusable impact, authoring, and validation procedures, and has Reviewer independently check relevant documentation. Preferred.

## Decision

Advanced Harness will not introduce a mandatory Documentation agent. Documentation ownership is distributed by subject and supported by shared documentation skills. Documentation is part of the relevant task lifecycle, not a required extra delegation. The author owns accuracy; Reviewer independently checks the result. Skills provide procedures and checklists but do not make decisions, grant permissions, or replace human approval.

| Role | Documentation responsibility |
| --- | --- |
| Lead | Track requirements and completion; coordinate handoffs and approvals. |
| Planner | Author and maintain architectural decisions, design rationale, and technical plans. |
| Engineer | Update implementation documentation, examples, integration notes, and developer instructions affected by implementation. |
| Reviewer | Independently verify accuracy, completeness, and alignment with requirements, implementation, and approved decisions. |
| Operations | Maintain operational metadata and perform authorized repository or publication actions; no default ownership of technical content. |

Ownership follows the responsibility if role names or topology change. Planner authors ADRs because Planner owns the architectural reasoning. An ADR remains Proposed until accepted through the project's approval process. Engineer documents implementation behavior and must escalate material deviations instead of rewriting an approved decision. Lead tracks the requirement and approval state.

Reviewer checks that documented behavior matches implementation; required material is present; commands, paths, examples, configuration names, and links are correct; architectural content reflects approved decisions; and claims have evidence. Reviewer receives requirements, relevant documentation, the implementation diff, constraints, and objective evidence, and does not rely solely on the author's explanation. Reviewer reports findings without silently editing the work under review.

## Shared Documentation Skills

Initial reusable skills:

| Skill | Purpose |
| --- | --- |
| `documentation-impact` | Identify whether a change requires documentation and list affected artifacts. |
| `adr-authoring` | Draft and update ADRs using project conventions and status. |
| `technical-documentation` | Write developer guides, configuration references, examples, and implementation documentation. |
| `documentation-validation` | Check links, examples, commands, consistency, and correspondence with implementation. |
| `documentation-review` | Provide an independent accuracy, completeness, and alignment checklist. |

Skills contain reusable procedures, templates, conventions, and tool instructions. They are not hidden decision-making agents and do not expand the invoking role's permissions. Engineer and Reviewer may use the same mechanical validation procedure while retaining independent judgment.

## Workflow and Triggers

Planner identifies documentation implications during planning, including whether an architectural change needs an ADR. Engineer updates implementation documentation with code where practical and runs applicable checks. Reviewer assesses it independently and may rerun checks or request evidence. Lead tracks unresolved findings and approvals. Operations publishes only through the existing authorized workflow.

Documentation is expected when a change materially affects public APIs, integration contracts, installation/configuration/deployment, user-visible behavior, developer or operational workflows, architecture, supported host behavior, agent responsibilities, permissions, workflow commands, or relied-upon repository instructions. Trivial changes and internal refactors do not automatically require edits. When impact is uncertain, the responsible agent records an explicit assessment.

## Exceptions

A task-scoped specialist or temporary execution context may be justified for large migrations, comprehensive restructuring, extensive user-guide creation, audits across independent modules, parallelizable documentation work, localization/editorial expertise, or the backlog workflow for scoped `AGENTS.md` generation. This exception does not create a permanent mandatory role. Planner scopes the work; shared skills guide authoring; Reviewer checks it independently; Lead coordinates required approval.

## Consequences

**Positive:** Documentation remains close to authoritative context; routine handoffs are reduced; shared skills improve consistency; independent review remains explicit; large efforts have an exception path.

**Negative:** Agents must identify documentation impact and maintain skill guidance; review adds work for documentation-bearing changes; complex work may still need specialist coordination.

**Neutral:** BH-042's scoped `AGENTS.md` workflow remains compatible as an on-demand capability. This ADR does not implement that workflow or change the backlog.

## Adoption and Reconsideration

This Proposed ADR does not change installed roles or workflows. Implementation requires a separate approved plan and validation. Reconsider if distributed authorship repeatedly causes material inaccuracies or inconsistency, independent review misses defects, or a persistent specialist measurably reduces total cost without weakening source ownership or review. Evaluate quality, latency, cost, and handoffs.

## References

- Backlog issue BH-042, “Workflow to generate and update AGENTS.md documentation.”
- ADR: *Consolidate Agent Responsibilities While Preserving Specialized Reasoning and Independent Review*.
