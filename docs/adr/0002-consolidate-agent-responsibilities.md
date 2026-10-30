# ADR: Consolidate Agent Responsibilities While Preserving Specialized Reasoning and Independent Review

**Status:** Proposed\
**Date:** 2026-10-30\
**Project:** Advanced Harness\
**Decision scope:** Agent architecture, responsibility boundaries, model allocation, and workflow orchestration

## Context

Advanced Harness currently defines eight roles: Lead, Operator, External, Researcher, Planner, Implementer, Reviewer, and QA. The separation provides specialized instructions, differentiated model assignments, reduced tool exposure, independent review, explicit human approval boundaries, and separation of local and external operations. Each mandatory handoff can also add latency, token use, context reconstruction, and coordination overhead. Some responsibilities require separate reasoning contexts or authority; other responsibilities are reusable procedures rather than distinct agents.

The objective is to reduce unnecessary coordination while preserving boundaries that improve correctness, security, and engineering quality. This ADR proposes a target for evaluation; it does not itself authorize an implementation or production configuration change. Documentation ownership is covered separately by *Documentation Ownership Through Shared Skills*.

## Decision Drivers

Engineering quality; context and model efficiency; independent review; least privilege; human approval; compatibility across hosts; simplicity; observability; and reversible rollout.

## Considered Alternatives

### A. Retain Eight Roles

Preserves current responsibilities, permission boundaries, and migration safety. It may duplicate research and implementation discovery, add repetitive QA handoffs, and be unnecessarily complex for routine tasks. Keep as the evaluation baseline.

### B. One General-Purpose Agent

Minimizes delegation and maximizes context continuity, but removes independent review, concentrates permissions, makes failures harder to isolate, and risks self-validation. Rejected as the default; an experiment is possible only under equivalent approval and permission constraints.

### C. Selective Consolidation

Combines closely related execution work, converts procedural responsibilities to shared skills, and preserves roles with distinct reasoning or authority. Requires updated contracts and empirical validation, but is the preferred target.

## Decision

Evaluate a conditional five-role target:

| Role | Primary responsibility | Suggested model tier |
| --- | --- | --- |
| Lead | Coordination, delegation, workflow state, human approvals | Economical or mid-tier |
| Planner | Architecture, technical design, risk, implementation planning | Frontier reasoning |
| Engineer | Repository investigation, implementation, self-verification | Economical or mid-tier coding |
| Reviewer | Independent critical review and verification | Strong reasoning |
| Operations | Local Git, external integrations, authorized publication | Economical |

Five logical roles do not mean five agents must run for each task. Operations remains split into Operator and External wherever the host cannot preserve the necessary capability and permission isolation. QA becomes shared validation skills available to Engineer and Reviewer. Researcher and Implementer merge into Engineer.

## Role Boundaries

### Lead — Orchestration

Lead interprets the requested workflow, selects the next role or action, tracks progress and approvals, coordinates handoffs, and escalates architectural questions to Planner. Lead does not override an approved technical plan or substitute its technical judgment for Planner or Reviewer. Routine coordination does not require a frontier model; Luna or an equivalent economical model is suitable when validated.

### Planner — Technical Reasoning

Planner analyzes requirements and constraints, evaluates alternatives and risks, defines the implementation strategy and acceptance criteria, specifies validation, and creates or updates ADRs. Planner remains separate from routine implementation. A frontier reasoning model such as Astra or Sol may be used where supported and verified. Routine repository discovery can go to Engineer when useful.

### Engineer — Research and Implementation

Engineer combines Researcher and Implementer responsibilities: inspect repository structure, patterns, dependencies, and tests; provide findings to Planner; implement approved changes; maintain tests; run applicable checks; update implementation documentation; and report deviations and evidence. Reuse the same context between research and implementation where safe session continuation is supported. Otherwise, produce a structured research artifact to avoid repeating discovery.

Before implementation approval, Engineer stays within the permitted read-only research scope. After approval, implementation follows host-supported permissions. Material changes to the approved approach return to Lead and Planner, and to the human when required; Engineer must not silently reinterpret the plan.

### Reviewer — Independent Evaluation

Reviewer remains separate with an independent reasoning context. Reviewer checks requirements, defects, regressions, security, architecture, test adequacy, documentation, and objective evidence; findings include severity, evidence, and actionable explanations. Reviewer initially receives requirements, approved constraints, the diff, relevant conventions, and verification evidence, not the author's entire reasoning history unless needed for fair review. Reviewer may request context but does not edit or silently fix the work under review. Use a strong reasoning model when its quality benefit justifies its cost. Distinguish implementation defects from objections to the plan.

### Operations — Local and External Actions

Operations may handle Git status, local branch/worktree operations, approved external integrations, pushes, and pull request creation. It does not approve plans, implement application changes, or merge pull requests. Publication requires final human approval; only a human merges.

Combining Operator and External is conditional. Before consolidation on a host, validate effective permissions and tool exposure for local repository actions versus external or remote writes. If the host cannot enforce the required separation, retain Operator and External separately or leave the five-role target unapplied on that host. Prompt text alone is not an independently enforced security boundary.

### QA — Shared Validation Skills

QA becomes reusable skills for Android builds, unit tests, static analysis, visual regression, end-to-end checks, and evidence collection. Skills describe reproducible procedures and artifact locations; they do not decide whether results are acceptable. Engineer uses applicable skills for self-verification and records actual results. Reviewer inspects evidence and selectively reruns checks.

Reviewer retains read-only access to source and baselines under the host permission model. Checks that write files use an approved disposable environment or another method that leaves the reviewed tree unchanged. A passing command is evidence about that command, not automatic acceptance. Baseline updates remain subject to Reviewer evaluation.

## Model Allocation

Assign models by responsibility: economical or mid-tier for Lead, frontier reasoning for Planner, economical or mid-tier coding for Engineer, strong reasoning for Reviewer, and economical for Operations. These are tiers, not fixed provider IDs. Exact models and variants depend on validated host capabilities. BH-043's per-agent model selection and discovery work is related: provide explicit per-role selection where supported; report limitations where unavailable; do not silently substitute. A configured label does not prove entitlement or successful access. Claim a model was used only when runtime evidence supports that claim.

## Workflow and Invocation

A routine low-risk change may need Lead and Engineer, applicable checks, and risk-appropriate review. Architectural changes involve Planner and may need human approval. Reviewer remains independent for work requiring review. Operations is invoked only for operational work.

1. Lead presents the scoped plan and waits for explicit approval when required.
2. Engineer investigates within scope and implements only after required approval.
3. Material scope or approach changes return to the human for approval.
4. Engineer records checks actually run and their evidence.
5. Reviewer evaluates independently and reports findings.
6. Lead presents findings and verification status; the human decides on findings and publication.
7. Operations performs approved publication actions; a human merges.

Role membership and model assignment do not grant approval authority. Host permissions and their limitations remain explicit.

## Evaluation

Use the current eight-role configuration as the baseline. Compare the target on equivalent representative tasks: routine implementation, research then implementation, architecture, substantial QA/visual work, and local/external operations across supported hosts. Record task criteria and host/model configuration. Measure review-detected and escaped defects, requirement coverage, rework and plan drift, handoffs and context reconstruction, latency, model/token cost, evidence quality, permission ambiguities, and human interventions. Fewer roles alone do not demonstrate improvement. Evaluation does not authorize live configuration changes.

## Adoption and Rollout

1. Record current eight-role behavior and representative baseline tasks.
2. Define consolidated role contracts and QA skills without changing production configuration.
3. Pilot Researcher + Implementer as Engineer on low-risk approved tasks.
4. Pilot shared QA skills while preserving independent Reviewer reasoning and read-only source access.
5. Validate per-role model routing and actual host permissions.
6. Evaluate Operations + External only where permission isolation is demonstrated; otherwise retain the split.
7. Compare quality, cost, latency, and handoffs.
8. Obtain human approval for a concrete rollout plan before changing defaults.

Rollback restores the previous role configuration and workflow. Compiling templates or setting desired model labels alone does not establish a successful migration.

## Consequences

**Positive:** Less duplicate discovery and avoidable handoff; distinct architecture and review reasoning preserved; QA procedures reused without merging author and reviewer judgment; model cost follows responsibility; permission isolation is an explicit condition; rollout is measured and reversible.

**Negative:** Engineer needs clear escalation rules; shared skills and evidence conventions need maintenance; evaluation adds work; host permission differences may produce different role counts; some hosts may not support or expose per-role routing.

**Neutral:** Eight roles remain the baseline during evaluation and wherever consolidation conditions are unmet. Five roles are a conditional target, not a per-task invocation count. Model examples describe tiers only.

## Reconsideration

Reconsider if evaluation finds material quality regression, handoff savings do not offset other costs, the broader Engineer role repeatedly drifts from plan, or a host cannot preserve Reviewer independence or operational permission isolation. Base reconsideration on recorded outcomes and host-specific evidence. Adoption or permission changes require a separate approved implementation plan.

## References

- README, “Agents and fixed per-host model presets.”
- Backlog issue BH-042, “Workflow to generate and update AGENTS.md documentation.”
- Backlog issue BH-043, “Per-agent model selection and live model discovery across hosts.”
- ADR: *Documentation Ownership Through Shared Skills*.
