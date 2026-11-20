# ADR: Evaluation Runner Bindings and Outcome Model

**Status:** Proposed\
**Date:** 2026-11-19\
**Project:** Advanced Harness\
**Decision scope:** How the EDD v1 evaluation runner binds scenarios to executable checks, how a run's observed facts become an evaluation outcome, how repeat runs are compared, and how isolation is recorded for deterministic mode.

## Context

Issue #225 merged the EDD v1 evaluation contracts: scenario, rubric, run manifest, and evaluation result schemas, with TypeScript validators. No runner exists yet. Issue #226 is expected to deliver it.

Issue #62 delivers a deterministic agent E2E suite. It runs the real OpenCode 2.3.0 CLI against a loopback model fixture and writes a journey record. The journey record is a suite-level artifact, not an evaluation result. [ADR-011](0011-deterministic-agent-e2e-via-loopback-model-fixture.md) defers the mapping from journey records to evaluation results to #226.

The term `inconclusive` has two meanings in the project. A scenario's `expectedOutcome.status` can be `inconclusive`, meaning the run must stop without claiming success. An evaluation result's `outcome` can also be `inconclusive`, meaning the run finished but its evidence cannot decide. The contracts do not separate the two, so a result can be recorded that contradicts its own expectation.

Scenario stimuli are free text. A scenario's `stimulus.userPrompt` and `stimulus.events` cannot be executed by a runner directly, so each scenario needs a binding that the runner can execute.

## Decision Drivers

1. Repeatable deterministic verdicts, with no secrets, no live model, and no network access.
2. Honest outcomes: a run that did not execute is never a pass.
3. Scenario contracts are unchanged. The scenario schema and the scenario corpus do not change for the runner.
4. The holdout is preserved. The runner does not tune against `EDD-VAL-*` scenarios, and bindings are not written from them.
5. Scripted replies cannot prove prompt behaviour. A result must say what it does and does not show.

## Considered Options

### A. Binding location

1. **Separate binding modules per scenario under `e2e/`** (chosen). Each module binds one scenario ID and version to its executable checks. A stale version is an infrastructure error, not a silent reuse. The scenario contract is unchanged.
2. **A schema field on the scenario.** This puts executable detail into the corpus and changes the scenario contract. Rejected.
3. **A central registry.** One file would list every binding. It is harder to review per scenario and gives no version check. Rejected.

### B. Outcome recording

1. **No schema change** (chosen). The expected status and the observed status are recorded in the first `observableStateChecks` entry (`observed status <x> matches expected <y>`) and in `reason`. Metrics that were not observed are zero, and the `reason` says `metrics not observed`. This entry is present only for completed runs (`pass`, `fail`, and `inconclusive` results); skipped and infrastructure_error results have no checks and record the status in reason.
2. **New result fields** for the observed status and for whether metrics were observed. This is clearer, but it changes the result contract, which #225 merged. Deferred; see Reconsideration.

### C. Runtime

1. **Real OpenCode 2.3.0 through the loopback fixture** (chosen for deterministic mode). The runner evaluates facts from the real run. The fixture makes every model reply scripted, so runs repeat and need no credentials.
2. **Pure replay of scripted facts.** A replay checks the harness's own script, not the installed prompts, skills, or permission policy. Rejected for the gate: scripted replies cannot prove prompt behaviour.

## Decision

1. **Bindings.** Each scenario that the runner executes has its own binding module under the `e2e/` directory, keyed by scenario ID and scenario version. The exact location is set by the implementation unit. A binding whose version differs from the scenario's version gives `infrastructure_error`. A scenario without a binding is `skipped`, with the reason stated.
2. **Outcome rules.** The evaluation outcome follows the rules in [the outcome model](../evaluation.md#outcome-model):
   - `pass`: the observed status equals `expectedOutcome.status`, and every `observableFinalState` assertion holds. A negative scenario whose deliberate violation is rejected is a `pass`.
   - `fail`: the observed behaviour contradicts the expectation.
   - `inconclusive`: the run finished but the evidence cannot decide.
   - `skipped`: deliberately not executed.
   - `infrastructure_error`: the runner, fixture, binary, sandbox, or binding failed, or isolation was breached. Not valid evidence.

   The expected status is recorded as described in Option B.1.
3. **Metrics and artifact gating.** For `skipped`, `infrastructure_error`, and `inconclusive`, metrics are zero or empty, and the reason says `metrics not observed`. A missing `requiredArtifacts` entry gives `inconclusive`. The journey-record mapping copies `handoffCount`, maps role transitions to `from->to` strings, and lists loaded skills; other counters are not observed and are recorded as zero.
4. **Repeatability.** The normalizer removes `runId`, top-level `durationMs`, `evidence[].execution.durationMs`, the run-directory prefix of artifact paths, and a manifest's `createdAt`. The comparator reports a `repeatable` boolean and a field-level diff. It does not change any repeat's outcome.
5. **Observed isolation.** Each deterministic run records an isolation evidence entry (`check.name` `isolation`, `check.category` `custom`, `execution.basis` `re-run`) with the network record and the enforcement value (`netns` or `none`). An unexpected network destination or a credential-shaped header is an isolation breach and gives `infrastructure_error`.
6. **Mode.** This decision covers deterministic mode only. Live mode and an LLM judge are documented but are outside the deterministic gate. They are not implemented by this decision.

## Consequences

**Positive:** Deterministic verdicts repeat, and a run that did not execute cannot pass. The scenario contract and corpus are unchanged. A binding cannot silently run against a changed scenario.

**Negative:** In deterministic mode, many scenarios will be `skipped`, because only the scenarios with bindings run. The zero metrics of non-decided results are meaningful only through the `metrics not observed` convention, which consumers must read. Windows runs are not hermetic and are not authoritative for isolation. The evidence for real-run results is produced on demand by `npm run eval:opencode:e2e` with a real OpenCode 2.3.0 binary. It is not part of CI. The `agent-e2e` job covers only the journeys file. Neither is a required check.

**Neutral:** The outcome is recorded in existing fields, which keeps the result contract unchanged and makes the expected status readable only through the first check and the `reason` text.

## Adoption

Accepting this ADR does not change tooling, roles, permissions, defaults, or CI. It does not make the `agent-e2e` job, `npm run eval:opencode:e2e`, the evaluation runner, or any evaluation check a required check. The runner, its bindings, the outcome and normalization helpers, the deterministic rubric, and the documentation are delivered by separately approved implementation units under issue #226. Each unit needs its own scoped plan and human approval.

Rollback removes the runner, the bindings, the helpers, the deterministic rubric, and the documentation sections added for this decision. It does not modify machine configuration, the scenario corpus, or the result schema.

## Reconsideration

Reopen this decision when one of these is observed:

- issue #261 is fixed, so the `edit` and `skill` tools can be bound to scenarios, and the skipped share of deterministic runs is too high to be useful;
- the result schema gains an observed-status field or a metrics-observed field, so the expected status and the not-observed metrics no longer rely on text;
- a live runner or an LLM judge is added, so the deterministic-only scope changes;
- OpenCode is re-pinned, so the tolerated startup destinations or the observed behaviour that the bindings rely on change;
- the share of `skipped` scenarios in deterministic mode is too high to support the milestone's evaluation goals.

This ADR is reviewed at each milestone close.

## References

- [Evaluation: outcome model](../evaluation.md#outcome-model)
- [ADR-011: Deterministic Agent E2E via a Loopback Model Fixture](0011-deterministic-agent-e2e-via-loopback-model-fixture.md)
- [Agent E2E suite guide](../agent-e2e.md)
- [Glossary: Evaluation](../glossary.md#evaluation-edd)
- Issues #225 (evaluation contracts), #62 (agent E2E suite), #226 (evaluation runner), and #261 (skill journey defect)
