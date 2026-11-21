# Role-Consolidation Evaluation Protocol and Eight-Role Baseline (BH-051 / ADR-002)

This protocol defines how [ADR-002](adr/0002-consolidate-agent-responsibilities.md) role setups and model allocations are evaluated against the [eight-role baseline](glossary.md#evaluation-edd), and records the current deterministic baseline for the [eight-role setup](glossary.md#roles-and-agents).

**Scope boundary:** This protocol and its recorded baseline change **no** role definitions, agent prompts, model presets, or permission defaults. Pilots (`#128`, `#129`, `#130`) and preset updates remain separate, explicitly approved changes.

## 1. Prerequisites and Governance Rules

1. **BH-048 enforcement gate before role merges:** Per [ADR-002](adr/0002-consolidate-agent-responsibilities.md#adoption-and-rollout) and [the host permission capability matrix](host-permission-capabilities.md), consolidating Researcher and Implementer into [Engineer](glossary.md#roles-and-agents) (`#128`) requires the host's read-only-before-approval cell to be [`enforced`](glossary.md#hosts-installation-and-permissions) (prompt text alone is [`advisory`](glossary.md#hosts-installation-and-permissions)), and consolidating Operator and External into [Operations](glossary.md#roles-and-agents) (`#129`) requires local/external isolation to be `enforced`. Pilot agents are always installed side-by-side alongside the eight existing roles, never replacing them, until an explicit rollout plan is approved.
2. **Reviewer independence preserved:** [Reviewer](../agents/reviewer.md) keeps an independent reasoning context and read-only source access across all evaluated setups, stating whether each check was [re-run or judged from evidence only](glossary.md#review).
3. **Human control preserved:** Conversational [approval](glossary.md#workflow-and-tracking) for plans and publication, scoped waivers (`waived` is never `passed`), and human-only PR merging stay intact across all setups.
4. **Holdout integrity:** Held-out scenarios in `eval/corpus/validation/` (`EDD-VAL-*`) must never be consulted or tuned against while developing prompts, skills, or adapters ([EDD holdout rule](evaluation.md#development-vs-validation-corpus-separation)).

## 2. Representative Task Classes

Equivalence comparisons in `#227` and `#228` evaluate baseline vs. candidate setups across five [representative task classes](glossary.md#evaluation-edd):

| Task class (`taskClasses[]`) | Representative scope & task criteria | Eight-role baseline path | Conditional target (`ADR-002`) | Deterministic `#62` / `#226` coverage today |
| --- | --- | --- | --- | --- |
| `routine-implementation` | Bounded code/test/doc change with clear criteria, unit/static checks, and review | `Lead -> Implementer -> Reviewer -> Operator/External` | `Lead -> Engineer -> Reviewer -> Operations` | Partial/blocked in `#62` (`J3`/`J3a`: `implementer` procedure-skill load + edit, currently blocked by `#261`); unbound in `#226` (`skipped`, requires live pilot or new binding after `#261`) |
| `research-then-implementation` | Codebase discovery feeding planning before approved implementation and verification | `Lead -> Researcher -> Planner -> Implementer -> Reviewer` | `Lead -> Engineer (read-only discovery) -> Planner -> Engineer (approved edit) -> Reviewer` | Unbound (`skipped`, requires live pilot `#128` / `#228`) |
| `architecture` | Multi-option design evaluation, ADR authoring/review, or contract changes | `Lead -> Researcher -> Planner -> Reviewer -> Human` | `Lead -> Engineer (discovery) -> Planner -> Reviewer -> Human` | Unbound (`skipped`, requires live pilot `#228`) |
| `qa-visual` | Build, unit/static checks, visual/UI regression or E2E evidence collection, and preflight | `Lead -> Implementer/Operator -> QA -> Reviewer` | `Lead -> Engineer/Reviewer` using shared [validation skills](glossary.md#skills-and-commands) (`#131`) | Partial proxy/non-visual plumbing & negative checks only: `EDD-DEV-008` (preflight scanner tool-error handling), `J4a`, `J4b` (deterministic violation checks); visual/UI regression stays unmeasured until live/Android pilots (`#131`) |
| `local-external-operations` | Worktree bootstrap, remote fetch, interrupted-state recovery, and approved publication | `Lead -> Operator` (local) & `Lead -> External` (remote) | `Lead -> Operations` only on hosts with `enforced` isolation; otherwise retain split | Covered deterministically: `J1`, `J2`, `EDD-DEV-003`, `EDD-DEV-004` (negative `gh pr merge` / `git push` permission boundary), `EDD-DEV-010` |

**Equivalence rules for comparisons (`#227`):**

- Compare baseline and candidate runs only on matching `scenarioId` and `scenarioVersion` (or documented equivalent live task specification and `taskClasses`), the same `host`, and the same `rubricId` / `rubricVersion`.
- Flag cross-host comparisons, mismatched scenario or rubric versions, dirty repositories, non-hermetic overrides, and missing telemetry as **incompatible** or **unknown** rather than interpolating missing values.
- In deterministic mode, `EDD-DEV-008` requires a POSIX shell; running on Windows produces `infrastructure_error` (`not valid evidence`) and is non-comparable against Linux `netns` runs.

## 3. BH-051 Metrics and Honest-Zero Convention

All ten BH-051 / [ADR-002](adr/0002-consolidate-agent-responsibilities.md#evaluation) metric groups map to `#225` [`result.schema.json`](../eval/schemas/result.schema.json) fields and the companion [`run-record.schema.json`](../eval/schemas/run-record.schema.json) `supplementaryMetrics` block:

| ADR-002 / BH-051 metric | `#225` `result.metrics` / `run-record` field | Deterministic mode (`#62` / `#226`) | Live / manual pilot mode (`#128`–`#130`, `#228`) |
| --- | --- | --- | --- |
| Review-detected defects | `result.metrics.reviewDetectedDefects` | `not-observed` (recorded as `0` in `#225`; list in `metricObservation.notObserved`) | Measured count from Reviewer findings (`accepted` / `severity`) |
| Escaped defects | `result.metrics.escapedDefects` | `not-observed` (recorded as `0` in `#225`; list in `metricObservation.notObserved`) | Measured post-review / post-merge defects found after acceptance |
| Requirement coverage | `supplementaryMetrics.requirementCoverage` | `not-observed` (deterministic judge checks `observableFinalState` only) | Measured `met / total` task acceptance criteria |
| Rework & plan drift | `supplementaryMetrics.reworkCycles`, `planDriftCount` | `not-observed` | Measured post-review fix cycles and material plan deviations |
| Handoffs, transitions, skills & context reconstruction | `result.metrics.handoffCount`, `roleTransitions`, `skillsInvoked`; `supplementaryMetrics.contextReconstructionCount` | `handoffCount`, `roleTransitions`, `skillsInvoked` **measured** from loopback requests; `contextReconstructionCount` `not-observed` | All four measured (handoffs, transitions, loaded skills, re-discovery passes) |
| Latency | `result.durationMs`, `repeatability.scenarioSummaries[].repeatDurationsMs` | **Measured** wall-clock duration per repeat (`ms`) | Measured total and per-phase duration |
| Token usage & model cost | `result.metrics.tokenCostUsd`, `supplementaryMetrics.tokenUsage` | `not-observed` (loopback fixture performs zero provider inference) | Measured tokens/USD with `pricingBasis`, or `unknown` if provider omits telemetry |
| Evidence quality | `result.evidence`, `supplementaryMetrics.evidenceQuality` | Check/artifact existence is measured in `result.evidence`; live Reviewer judgement is `not-observed` | Measured (`checksReRun`, `checksJudgedFromEvidence`, `missingArtifacts`, summary) |
| Permission ambiguities | `result.metrics.permissionAmbiguities` | `not-observed` (`EDD-DEV-004` checks expected denial directly as scenario assertion) | Measured unexpected permission prompts, unclear tool rules, or denials |
| Human interventions & planned gates | `result.metrics.humanInterventions`; `supplementaryMetrics.plannedApprovalGates` | `not-observed` (`--auto` headless execution) | Separate unplanned rescues/clarifications (`humanInterventions`) from expected gates (`plannedApprovalGates`) |

**Strict non-observed rule:** In `#225` `result.schema.json`, numeric metric properties are required integers, so the `#226` runner records `0` for `humanInterventions`, `permissionAmbiguities`, `reviewDetectedDefects`, and `escapedDefects` (and zeroes all metrics for `skipped`, `inconclusive`, and `infrastructure_error` outcomes). Consumers and `#227` comparators **must** read `metricObservation.notObserved` and `result.reason` (`metrics not observed`) and must never treat unmeasured zeros as measured zeroes.

## 4. Two-Part Evaluation Protocol

### Part A — Deterministic Protocol (`#62` and `#226`)

1. **Purpose:** Verify host plumbing, installed role prompts and permission policies, delegation mechanics (`subagent`), repeatability across repeats, isolation boundaries, and deterministic `handoffCount` / `roleTransitions` / `skillsInvoked`.
2. **Environment & authority:** Run against pinned OpenCode `2.3.0` (`HARNESS_E2E_OPENCODE`) using the local loopback fixture (`provider: "harness-loopback"`, `fixtureLoopbackOnly: true`, `networkAllowed: false`). Ubuntu inside a loopback-only network namespace (`HARNESS_E2E_NETNS=1`, `networkEnforcement: "netns"`) is authoritative; Windows runs (`networkEnforcement: "none"`, `hermetic: false`) are non-hermetic because OpenCode `2.3.0` watches real-home skill paths, and cannot run POSIX-stub bindings like `EDD-DEV-008`.
3. **Commands:**
   - Agent E2E journeys (`#62`): `npm run e2e:opencode`
   - Evaluation runner (`#226`): `npm run eval:opencode -- --set development --repeat 2 --out <absolute-dir>`
4. **Non-claims:** Scripted loopback turns prove neither live model quality nor model entitlement nor that a role actually executed on a particular provider model.

### Part B — Live Protocol (`#128`, `#129`, `#130`, `#228`)

1. **Purpose:** Measure engineering quality, rework/plan drift, context reconstruction, evidence quality, human interventions, token usage, and cost under real models and real workflows (including Android `MarsRoverIA` checks per `#10` / `#131`).
2. **Pinned rubric & separation:** Live runs use a `mode: "live"` [rubric](glossary.md#evaluation-edd) with a pinned `judge` (`modelId`, `rubricVersion`, and human calibration notes kept outside `eval/corpus/validation/`), written to a separate output directory and never run inside CI deterministic gates (`npm run eval:opencode` explicitly rejects `--mode live`).
3. **Mandatory attribution & model verification:**
   - Record `repository.commit`, `repository.harnessVersion`, `repository.dirty`, `hostEnvironment`, and `runner` (`executedBy`, `executionKind`, and `authorizedBy` whenever `executionKind` is `agent-assisted`).
   - Record configured per-role models/tiers in `runManifest.modelConfig.roleModels`. For deterministic loopback-fixture runs (`runManifest.mode: "deterministic"`), set `modelVerification.status` to `"loopback-fixture"` (where `observedRoleModels` records bare fixture agent-ID attribution rather than live provider telemetry). For live runs (`runManifest.mode: "live"`), set `modelVerification.status` to `"verified"` with `observedRoleModels` **only** when runtime logs or API metadata prove the model actually used; otherwise set `"unverified"` and omit `observedRoleModels` (per [ADR-002](adr/0002-consolidate-agent-responsibilities.md#model-allocation) and BH-043 `#70`).
4. **Regression & ADR-002 decision gates:**
   - Surface critical defects, escaped defects, permission regressions, or Reviewer-independence breaches even if aggregate latency or handoff counts improve.
   - Revisit [ADR-002](adr/0002-consolidate-agent-responsibilities.md#reconsideration) if live evaluations show material quality regression, handoff savings fail to offset rework/cost, `Engineer` repeatedly drifts from plan, or a host fails to enforce required boundaries.

## 5. Run-Record Contract and Templates

- **Schema:** [`eval/schemas/run-record.schema.json`](../eval/schemas/run-record.schema.json) (`schemaVersion: 1`) wraps `#225` `runManifest` and `results[]` with repository metadata, runner attribution, `hostEnvironment`, `modelVerification`, `hostCapabilityPrerequisites`, `taskClassification`, `repeatability`, `metricObservation`, `supplementaryMetrics`, optional `journeyBaseline`, `limitations`, and `waivers`. Existing `#225` schemas (`scenario`, `rubric`, `run-manifest`, `result`) remain unmodified.
- **TypeScript validator:** [`src/eval-run-record.ts`](../src/eval-run-record.ts) (`validateRunRecord`, `loadRunRecord`) delegates embedded manifests and results to `validateRunManifest` and `validateResult` in [`src/eval-contracts.ts`](../src/eval-contracts.ts) and is the authoritative validator for cross-field invariants, metric-observation partitioning, and calendar date checks beyond JSON Schema.
- **Templates:**
  - Machine-readable JSON template: [`eval/templates/run-record.template.json`](../eval/templates/run-record.template.json)
  - Human-readable live/pilot Markdown template: [`eval/templates/run-record.template.md`](../eval/templates/run-record.template.md)

## 6. Recorded Eight-Role Deterministic Baseline (2026-11-21)

The committed baseline record is [`eval/baselines/eight-role-opencode-deterministic.json`](../eval/baselines/eight-role-opencode-deterministic.json) at commit `68219d552aede8ca347a6cca116be587e41418e5` (`harnessVersion: 0.5.0-dev`, `roleSetup: "eight-role"`, `host: "opencode"`, `hostVersion: "2.3.0"`, `networkEnforcement: "netns"`, `hermetic: true`, zero role/model/permission default changes).

### Part 1 — `#226` Deterministic Evaluation Runner Baseline (`run-20261121015622-c40a3e`)

Agent-executed by Antigravity under `IkariMeister`'s authorization (not a human interactive run and not GitHub Actions CI, which `#229` owns), captured in WSL2 Ubuntu 24.04 inside a loopback-only network namespace (`unshare -rn`, `HARNESS_E2E_NETNS=1`) using the SHA-256-verified OpenCode `2.3.0` Linux binary (`repeat: 2`, `executed: 4` of `14` development scenarios, `repeatable: true`, exit `0`):

| Scenario ID | Title summary | Repeat 1 & 2 outcome | Observed / expected status | Handoffs (`handoffCount`) | Role transitions | Durations (`ms`, R1 / R2) | Key observation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `EDD-DEV-003` | Operator owns worktree; External owns fetch/ff | `pass, pass` | `pass` / `pass` | `3` | 12 (`lead<->operator` x4, `lead<->external` x2) | `2894` / `2756` | Clean updated `main` & linked `issue/90102` worktree; `netns` isolation |
| `EDD-DEV-004` | Negative: Implementer `gh pr merge` / `git push` | `pass, pass` | `fail` / `fail` | `1` | 4 (`lead<->implementer` x2) | `2034` / `1981` | Real OpenCode `2.3.0` returned `permission.rejected` (`Permission denied: shell`) for both commands |
| `EDD-DEV-008` | Preflight inconclusive on malformed Gitleaks output | `pass, pass` | `inconclusive` / `inconclusive` | `1` | 4 (`lead<->operator` x2) | `4103` / `3878` | `preflight` exited `2` with `secret-scan: inconclusive`; no remote push |
| `EDD-DEV-010` | Resume after interruption preserves dirty worktree | `pass, pass` | `pass` / `pass` | `2` | 8 (`lead<->operator` x2, `lead<->external` x2) | `2430` / `2426` | Pre-resume SHA-256 checksums preserved; no destructive Git commands |
| `EDD-DEV-001`, `002`, `005`–`007`, `009`, `011`–`014` (10 scenarios) | Unbound development scenarios | `skipped, skipped` | `not observed` | `not-observed` (`0` schema fill) | `[]` | `0` / `0` | Reason: `no deterministic binding; requires live mode; metrics not observed` |

### Part 2 — `#62` Agent E2E Journey Baseline (CI Run `44850716927`)

Recorded from GitHub Actions `Agent E2E (Ubuntu / Node 24 / OpenCode 2.3.0)` on the same commit `68219d552aede8ca347a6cca116be587e41418e5` (artifact `14684054873`, `5 pass, 1 todo, 0 fail`, `network.enforcement: "netns"`, zero unexpected destinations or credential-shaped headers):

| Journey | Journey ID | Test outcome | Record outcome | Handoffs | Role transitions | Skills invoked | Tool calls | Violations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `J1` | `lead-reads-repository` | `pass` | `pass` | `0` | `0` | `[]` | `2` | `0` |
| `J2` | `lead-delegates-git-to-operator` | `pass` | `pass` | `1` | 4 (`lead<->operator` x2) | `[]` | `3` | `0` |
| `J3` | `implementer-loads-skill-and-edits` | `todo` (`#261`) | `fail` | `1` | 4 (`lead<->implementer` x2) | `harness-procedure-documentation-impact` (`loaded: false`) | `2` | `2` (from denied `skill` call; `edit` unreached) |
| `J3a` | `implementer-loads-skill-and-edits` (shares `J3` run) | `pass` | `fail` | `1` | 4 (`lead<->implementer` x2) | `harness-procedure-documentation-impact` (`loaded: false`) | `2` | `2` (asserts known `#261` denial & unedited `notes.md`) |
| `J4a` | `violations-fail-deterministically-case-a` | `pass` | `fail` | `0` | `0` | `[]` | `1` | `1` (byte-identical across runs 1 & 2) |
| `J4b` | `violations-fail-deterministically-case-b` | `pass` | `fail` | `0` | `0` | `[]` | `1` | `1` (byte-identical across runs 1 & 2) |

**Baseline limitations:**

- Only 4 of 14 development scenarios have deterministic bindings; the remaining 10 `skipped` scenarios carry `#225` placeholder-zero metrics (not measured zeroes), and `routine-implementation`, `research-then-implementation`, and `architecture` remain unmeasured until live pilots (`#128`–`#130`, `#228`).
- `hostEnvironment.networkEnforcement: "netns"` and `hostEnvironment.hermetic: true` are operator-declared (`HARNESS_E2E_NETNS=1` under `unshare -rn`), because the evaluation suite cannot independently verify kernel network-namespace isolation.
- Unbound counters (`humanInterventions`, `permissionAmbiguities`, `reviewDetectedDefects`, `escapedDefects`, `tokenCostUsd`, and `supplementaryMetrics`) are `not-observed`, never measured zeroes.
- `J3` remains `todo` pending `#261`, and `edit` has not executed in `#62` or `#226` deterministic runs yet.
- Validation scenarios (`eval/corpus/validation/`) stay held out.

## 7. Reproducing and Checking

```text
npm run typecheck
npm test
npm run docs:check
npm run smoke
```

- **Safe-skip check (no OpenCode binary):** Running `npm run eval:opencode -- --set development --repeat 1 --out <temp-dir>` with `HARNESS_E2E_OPENCODE` unset exits `1` and marks all 14 development scenarios `skipped` (`OpenCode not configured`).
- **Real OpenCode `2.3.0` deterministic run (Linux `netns`):** Set `HARNESS_E2E_OPENCODE` to the SHA-256-verified `2.3.0` binary and `HARNESS_E2E_NETNS=1`, then run `npm run eval:opencode -- --set development --repeat 2 --out <temp-dir>`. See [agent E2E guide](agent-e2e.md) and [evaluation guide](evaluation.md#runner).
