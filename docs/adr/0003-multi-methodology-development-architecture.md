# ADR: Multi-Methodology Development Architecture

**Status:** Proposed  
**Date:** 2026-10-31  
**Version:** 1.1  
**Project:** Advanced Harness  
**Decision scope:** Methodology selection, task execution boundaries, workflow governance, and evaluation

## Context

Advanced Harness needs to support work with different sources of truth and different levels of uncertainty. A single prescribed development method can impose unnecessary ceremony on small, well-understood tasks or provide too little structure for ambiguous, high-impact work. Allowing every task to blend methods informally makes expectations, artifacts, and review criteria hard to predict.

The architecture must support requirements-driven development (RDD), specification-driven development (SDD), outcome-driven development (ODD), and a deliberate hybrid mode. Each is a complete, exclusive execution mode for a given work unit. Hybrid is a separately selected mode with explicit composition rules; it is not permission to mix methods ad hoc. A work unit is one project, a cohesive group of requirements, or a task. Different work units may use different modes, including within the same project, when their boundaries and dependencies are clear.

This ADR proposes a decision framework. It does not implement mode routing, change existing agent behavior, or imply that a mode provides technical or security enforcement. Human approvals and host permission limits remain governed by existing project rules.

## Decision Drivers

1. Match process rigor to uncertainty, impact, and the cost of failure.
2. Preserve a clear, auditable source of truth and expected artifacts for each work unit.
3. Support selection at project, requirement-group, and task scope without forcing one project-wide method.
4. Make hybrid use intentional, bounded, and reviewable.
5. Keep selection explainable through a weighted decision matrix and recorded trade-offs.
6. Preserve existing approval, independent review, and host-specific permission boundaries.
7. Revisit weights and guidance using observed outcomes rather than preference alone.

## Methodology Modes

The terms below define Advanced Harness execution modes. They do not claim that every external use of these acronyms has the same meaning.

### RDD — Requirements-Driven Development

Use when the desired behavior is sufficiently known and can be stated as verifiable requirements. Requirements and acceptance criteria are the controlling source of truth. Work proceeds by tracing implementation and validation back to those requirements. Clarify conflicts or gaps before treating assumptions as approved scope.

Typical artifacts: requirement set, acceptance criteria, traceability links, implementation plan proportionate to risk, and verification evidence.

### SDD — Specification-Driven Development

Use when correctness depends on a detailed, stable contract or coordinated behavior across components. An approved specification is the controlling source of truth and defines interfaces, invariants, states, constraints, and examples as applicable. Implementation changes that conflict with the specification require an explicit decision and corresponding specification update.

Typical artifacts: approved technical or behavioral specification, interface/state definitions, examples or models where useful, conformance criteria, and verification evidence.

### ODD — Outcome-Driven Development

Use when the goal and intended user or business outcome are clear, but the solution and detailed requirements should be discovered through bounded iteration. The outcome, guardrails, measures, and decision checkpoints are the controlling source of truth. Each iteration produces evidence and may refine the approach; it may not silently change the agreed outcome or constraints.

Typical artifacts: outcome statement, success measures, guardrails, hypotheses or unknowns, time or scope bounds, decision checkpoints, and evidence from each iteration.

### HYBRID — Explicitly Composed Development

Use when a work unit contains separable parts that materially benefit from different modes, or when one mode governs the work while another supplies a bounded sub-process. The plan must identify the primary mode, each secondary mode, their scope boundaries, source-of-truth precedence, interface between them, and how conflicting artifacts are reconciled. For example, ODD may govern discovery while an approved SDD contract governs a stable subsystem.

Hybrid is one explicit mode selection with a composition plan. It must not be used to avoid choosing a source of truth, to bypass a required approval, or to combine incompatible acceptance rules. If boundaries or precedence cannot be stated, select one mode or split the work into separately governed units.

## Selection Scope and Governance

Methodology may be selected for:

- **Project:** a default for new work in the project, recorded in project context when agreed.
- **Requirement group:** a cohesive group of related requirements with its own source of truth and acceptance criteria.
- **Task:** a bounded unit with a distinct goal, risk profile, and verification plan.

The narrowest clearly bounded scope governs. A task-level selection may specialize a requirement-group or project default only when the scope, reason, and resulting boundaries are recorded. A broader default does not silently override an explicit narrower selection. Shared interfaces and cross-scope dependencies must have an identified owner and compatible contracts; where they do not, surface the conflict and resolve it before implementation.

The person or role authorized by the project workflow proposes the mode and rationale. The human confirms architectural or materially consequential process choices under the existing approval workflow. Routine selection within an already approved project policy may follow that policy. Agents may recommend a mode but must not present the matrix score as human approval. The selected mode, scope, rationale, material trade-offs, and any exception are recorded with the task plan. Changes to mode that affect artifacts, acceptance, scope, or risk return through the existing approval path.

## Weighted Decision Matrix

Score each candidate mode from **1 (poor fit) to 5 (strong fit)** against the task evidence. Use weights from 1 (minor) to 5 (critical). A factor may be marked not applicable only with a brief reason, and its weight is omitted from the denominator.

| Factor | Default weight | RDD fit | SDD fit | ODD fit | HYBRID fit |
| --- | ---: | --- | --- | --- | --- |
| Requirements and acceptance criteria are known and testable | 5 | Strong | Medium | Weak | Depends on boundaries |
| Contract, interface, or invariant precision is critical | 5 | Medium | Strong | Weak | Strong for specified parts |
| Outcome is clear while solution details are uncertain | 5 | Weak | Medium | Strong | Strong if discovery is bounded |
| Uncertainty requires learning through iteration | 4 | Weak | Medium | Strong | Strong if learning and delivery scopes separate |
| Failure impact, regulatory exposure, or rollback cost | 5 | Strong with traceability | Strong with conformance controls | Medium with tight guardrails | Strong only with explicit controls |
| Components or teams require coordinated, stable contracts | 4 | Medium | Strong | Weak | Strong when only some boundaries are stable |
| Fast feedback and reversible experiments are practical | 3 | Medium | Medium | Strong | Strong when experiments do not weaken fixed contracts |
| Multiple distinct sources of truth exist in separable work | 3 | Weak | Medium | Medium | Strong |
| Method overhead is proportionate to work size and risk | 3 | Strong for bounded known work | Weak for simple work; strong for complex contracts | Strong for discovery | Weak unless composition reduces total risk or rework |

For each mode, calculate the weighted mean: `sum(weight × fit score) / sum(applicable weights)`. Use the scores as a structured discussion aid, not an automatic selector. Record the leading candidate, any close alternative, evidence behind material scores, and the reasons for overriding the ranking. A numerical lead does not outweigh a mandatory policy, contractual requirement, safety constraint, or human decision.

## Trade-offs

| Mode | Benefits | Costs and risks | Choose it when |
| --- | --- | --- | --- |
| RDD | Direct traceability; clear acceptance; efficient when scope is known | Weak requirements can encode assumptions; may discourage useful discovery | The desired behavior is known and testable |
| SDD | Precise coordination; stable interfaces and invariants; strong conformance review | Specification work can be expensive or stale; can slow learning when details are unsettled | Contract precision and cross-component consistency dominate |
| ODD | Supports discovery; ties iteration to measurable value; avoids premature solution detail | Outcomes can be vague or gamed; scope can drift without guardrails and checkpoints | The goal is stable while the path is uncertain and feedback is available |
| HYBRID | Fits heterogeneous work; allows discovery alongside stable contracts | Adds boundary and precedence overhead; conflicts can be obscured by the label | Distinct parts demonstrably need different modes and can be governed separately |

## Rigor and Tailoring

Rigor is selected independently of methodology for each selected scope. Each workflow supports three levels:

| Rigor | Use when | Expected discipline |
| --- | --- | --- |
| `minimal` | Work is bounded, low impact, readily reversible, and has few unknowns | State the controlling requirements, specification, or outcome concisely; define proportionate acceptance evidence; run focused checks and record results. |
| `standard` | Work has ordinary product or engineering impact, dependencies, or moderate uncertainty | Record a scoped plan, relevant traceability or measures, material risks, applicable verification, and independent review where required by project policy. |
| `strict` | Failure is high impact, hard to reverse, security- or safety-sensitive, regulated, or materially uncertain | Use explicit assumptions and risk controls, detailed traceability or conformance criteria, comprehensive applicable verification, independent review, and required human decision gates. |

Rigor is not a proxy for choosing a methodology. For example, an ODD task can be `strict`, and a small RDD task can be `minimal`. HYBRID assigns a rigor level to each constituent scope; shared interfaces use the highest rigor required by their risks and governing policy. A broader scope may set a minimum rigor, and a narrower scope may raise it. Lowering an inherited or mandatory level requires the authority defined by project governance and cannot waive required controls.

For every mode and rigor level, scale planning depth, evidence, review, and approval to impact, uncertainty, reversibility, and failure cost. RDD does not require exhaustive documentation for a trivial task; ODD does not excuse weak safety controls; SDD does not guarantee a correct specification; hybrid does not dilute any constituent part's required rigor. Mandatory project, legal, safety, security, and release controls apply regardless of matrix score.

The plan states required artifacts and checks. Lightweight work may use concise artifacts, while higher-risk work requires stronger traceability, independent review, and objective verification. Missing prerequisites or evidence remain explicit; they are not treated as passed because a methodology was selected.

## Consequences

**Positive:** Method selection is explainable and can vary at bounded scopes; requirements, specifications, and outcomes each have a clear role; hybrid composition is reviewable; rigor and method are not conflated; future evaluation can use recorded rationale and evidence.

**Negative:** Teams must maintain selection guidance and agree scope inheritance; scoring introduces judgment and may create false precision; hybrid mode costs extra planning and conflict resolution; project defaults can become stale if not reviewed.

**Neutral:** The matrix provides a default vocabulary and weights, not a mandate to select the highest score. Existing project approval, review, and permission rules continue to apply. This Proposed ADR does not alter current workflows.

## Review and Reconsideration Criteria

Review this decision after an initial pilot spanning known requirements, contract-heavy work, discovery work, and at least one justified hybrid case, and thereafter at a regular architecture review or when material evidence emerges. Evaluate:

- requirement coverage, escaped defects, rework, and changes caused by misunderstood scope;
- time to useful feedback, delivery time, and workflow overhead;
- quality and freshness of requirements/specifications/outcome measures;
- hybrid boundary or precedence conflicts and duplicated artifacts;
- whether chosen rigor matched impact and reversibility;
- human interventions, approval ambiguity, and consistency across teams/projects.

Reconsider the weights, criteria, mode definitions, or scope rules if the matrix repeatedly recommends poor fits, scoring is not reproducible enough to aid discussion, defaults cause friction or conceal conflicts, hybrid use becomes routine without clear boundaries, or outcomes show that the process cost exceeds its quality and coordination benefit. Preserve recorded examples and distinguish methodology effects from host/model/tool differences.

## Adoption

Adoption requires a separate approved implementation plan. That plan should define the project-context representation, selection and inheritance behavior, artifacts per mode, hybrid conflict handling, user-facing explanation, migration of existing tasks, evaluation data, and rollback. No tooling, templates, current role assignments, or project defaults change solely by accepting this ADR.

## References

- [ADR-001: Documentation Ownership Through Shared Skills](0001-documentation-ownership-through-shared-skills.md).
- [ADR-002: Consolidate Agent Responsibilities While Preserving Specialized Reasoning and Independent Review](0002-consolidate-agent-responsibilities.md).
- [Project workflow and approval boundaries](../../README.md#human-control-in-the-lead-conversation).
