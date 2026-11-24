# Evaluation-Driven Development (EDD) v1

Advanced Harness uses **Evaluation-Driven Development ([EDD](glossary.md#evaluation-edd))** to verify agent behavior, role boundaries, prompts, [procedure skills](glossary.md#skills-and-commands), [workflow commands](glossary.md#skills-and-commands), and host adapters against a versioned [scenario corpus](glossary.md#evaluation-edd).

## Alignment with related issues

<<<<<<< HEAD
- **BH-034 (#62) — Agent E2E suite on a loopback model fixture:** `npm run e2e:opencode` runs the real OpenCode 2.3.0 CLI through scripted journeys against a local loopback model fixture (`127.0.0.1`), with no live model or API keys. It does not execute the scenario corpus, and its journey record is not an evaluation result. After `#261` enabled J3 and retired J3a, the suite has 5 tests (7 OpenCode runs); the job is not a required check, and live OpenCode / interactive TTY spot-checks remain **waived**, not passed (see [Continuous integration](agent-e2e.md#continuous-integration) for recorded CI runs). See the [agent E2E guide](agent-e2e.md) and [ADR-0011](adr/0011-deterministic-agent-e2e-via-loopback-model-fixture.md). The [evaluation runner](#runner) maps it into evaluation results for bound scenarios.
=======
- **BH-034 (#62) — Agent E2E suite on a loopback model fixture:** `npm run e2e:opencode` runs the real OpenCode 2.3.0 CLI through scripted journeys against a local loopback model fixture (`127.0.0.1`), with no live model or API keys. It does not execute the scenario corpus, and its journey record is not an evaluation result. The J3 skill journey is `todo`, tracked in #261. Two `agent-e2e` CI runs have passed: run 43974715793 on PR 262, at head `172d19e` (before the review fixes), and run 44264679242 on head `3a901183…` (Validate, Smoke Ubuntu and Windows, Preflight scanner, and Agent E2E on Ubuntu/Node 24/OpenCode 2.3.0); the job is not a required check. See the [agent E2E guide](agent-e2e.md) and [ADR-0011](adr/0011-deterministic-agent-e2e-via-loopback-model-fixture.md). The [evaluation runner](#runner) maps it into evaluation results for bound scenarios.
>>>>>>> origin/main
- **BH-050 (#125) — QA validation evidence:** Result `evidence` entries follow a compact `schemaVersion: 1` check/execution structure (`check.name`, `check.category`, `execution.command`, `execution.exitStatus`, `execution.durationMs`, `execution.basis`, and `artifacts` paths), while scenario `evidence.format` references `"evidence-collection-v1"` as the label for [`evidence-collection`](../skills/evidence-collection/SKILL.md) alignment.
- **BH-051 (#126) — ADR-002 role-consolidation protocol:** Run manifests record the [role setup](glossary.md#roles-and-agents) (`eight-role` baseline or [pilot role setup](glossary.md#evaluation-edd)), host, and model configuration; results record `handoffCount`, `roleTransitions`, `skillsInvoked`, `humanInterventions`, `permissionAmbiguities`, `reviewDetectedDefects`, `escapedDefects`, and optional `tokenCostUsd`. The [role-consolidation evaluation protocol](role-consolidation-evaluation.md) defines the five [representative task classes](glossary.md#evaluation-edd), honest `not-observed`/`unknown` metric handling, [run record](glossary.md#evaluation-edd) schema/templates (`eval/templates/run-record.template.json`, `eval/templates/run-record.template.md`), and the recorded [eight-role baseline](glossary.md#evaluation-edd) (`eval/baselines/eight-role-opencode-deterministic.json`). No role, model, or permission defaults are changed.

## Versioned contracts (`schemaVersion: 1`)

All four `#225` contract schemas live in `eval/schemas/` and are validated by `src/eval-contracts.ts` (validation semantics unchanged by BH-051). The companion BH-051 run-record contract wraps `runManifest` and `results[]` in [`eval/schemas/run-record.schema.json`](../eval/schemas/run-record.schema.json) and is validated by [`src/eval-run-record.ts`](../src/eval-run-record.ts), which is the authoritative validator for cross-field invariants and calendar date checks beyond JSON Schema:

| Contract | Schema | Example / Template | Purpose |
| --- | --- | --- | --- |
| Scenario | [`eval/schemas/scenario.schema.json`](../eval/schemas/scenario.schema.json) | [`eval/examples/scenario.example.json`](../eval/examples/scenario.example.json) | Defines one versioned test scenario with preconditions, [stimulus](glossary.md#evaluation-edd), expected outcomes, observable final state, and required evidence. |
| Rubric | [`eval/schemas/rubric.schema.json`](../eval/schemas/rubric.schema.json) | [`eval/examples/rubric.example.json`](../eval/examples/rubric.example.json) | Defines deterministic assertions and, for separate live runs, pinned judge versions and calibrated criteria. |
| Run manifest | [`eval/schemas/run-manifest.schema.json`](../eval/schemas/run-manifest.schema.json) | [`eval/examples/run-manifest.example.json`](../eval/examples/run-manifest.example.json) | Records the evaluated host, role setup, model config, execution mode (`deterministic` or `live`), isolation config, and scenario IDs. |
| Evaluation result | [`eval/schemas/result.schema.json`](../eval/schemas/result.schema.json) | [`eval/examples/result.example.json`](../eval/examples/result.example.json) | Records per-scenario outcome (`pass`, `fail`, `skipped`, `inconclusive`, `infrastructure_error`), observable state checks, check/execution evidence, and recorded metrics. |
| Run record (BH-051) | [`eval/schemas/run-record.schema.json`](../eval/schemas/run-record.schema.json) | [`eval/templates/run-record.template.json`](../eval/templates/run-record.template.json) / [`eval/templates/run-record.template.md`](../eval/templates/run-record.template.md) | Composes `runManifest` and `results[]` with repository commit, runner attribution, model verification, BH-048 prerequisites, repeatability, and explicit `not-observed`/`unknown` metrics. |

## Scenario polarity, expected status, and observable final state

- **`polarity` (`positive` | `negative`):** A `positive` scenario exercises compliant expected behavior; a `negative` scenario introduces a boundary, permission, scope, tool-error, or recovery violation that guardrails or evaluators must reject.
- **`expectedOutcome.status` (`pass` | `fail` | `inconclusive`):** Names the [expected status](glossary.md#evaluation-edd) for the scenario: the status the run must stop with (`pass` when compliant behavior succeeds, `fail` when a negative violation is detected or rejected, `inconclusive` when a tool or ref error must stop the run without claiming success). It is not an evaluation outcome. A result's `outcome` is `pass` when the observed run matches `expectedOutcome.status` and satisfies every `expectedOutcome.observableFinalState` assertion; see the [outcome model](#outcome-model).
- **`expectedOutcome.observableFinalState`:** Across both positive and negative scenarios, assertions state **the compliant state the runner must observe** at the end of a compliant/blocked run (for example, that an unapproved edit, destructive cleanup, or unauthorized push did not occur).
- **Result consistency:** In `eval/schemas/result.schema.json`, `pass` and `fail` results require non-empty `observableStateChecks` and `evidence`, while `skipped`, `inconclusive`, and `infrastructure_error` allow empty arrays when execution did not complete. A `pass` result is rejected if any `observableStateChecks` entry has `passed: false`.
- **Validator-only checks:** `rubric.schema.json` does not enforce unique `criteria[].id` values in JSON Schema itself (`validateRubric` enforces uniqueness in TypeScript), and `run-manifest.schema.json` checks `createdAt` shape only while `validateRunManifest` also verifies real calendar/time validity.

## Outcome model

This section defines how a run's observed facts become an [evaluation result](glossary.md#evaluation-edd). It resolves the two meanings of `inconclusive`. The [expected status](glossary.md#evaluation-edd) is what a scenario's run must stop with. The evaluation outcome is what the run actually produced. An expected `inconclusive` is not an outcome: a run is recorded as `pass` only when its observed status equals the expected status. The model applies to deterministic mode only. Live runs and any judge are outside the deterministic gate and are not defined here. The runner that applies these rules exists; see the [Runner](#runner) section, the [agent E2E guide](agent-e2e.md), and [ADR-0012](adr/0012-evaluation-runner-bindings-and-outcome-model.md).

### Outcome rules

| Outcome | Rule |
| --- | --- |
| `pass` | The observed status equals `expectedOutcome.status`, and every `observableFinalState` assertion holds. A negative scenario whose [deliberate violation](glossary.md#evaluation-edd) was rejected or detected is a `pass`. |
| `fail` | The observed behaviour contradicts the expectation: a final-state check fails, a forbidden action happened, a loopback violation occurred (unscripted request, expectation mismatch, or unoffered tool), or the observed status differs from the expected status. |
| `inconclusive` | The run finished but evidence cannot decide: no evidence entries, a missing required artifact, a declared assertion with no observed check, or an observed `inconclusive` status against a different expectation. |
| `skipped` | The scenario was deliberately not executed. |
| `infrastructure_error` | The runner, fixture, binary, or sandbox failed, a binding was made for a different scenario version, isolation was breached (an unexpected network destination or a credential-shaped header), or the OpenCode run did not complete cleanly (status other than `completed`, a non-zero exit code, or a signal). A terminated run is not judged: its status, signal, and exit code are recorded in the evidence and reason, and the violations the journey recorded are kept as failing checks. This is not valid evidence and is never a pass. |

The rules are applied in this order: a run that did not complete cleanly gives `infrastructure_error` before any judgement; an isolation breach gives `infrastructure_error`; no evidence entries give `inconclusive`; a violation or a failed final-state check gives `fail`; an observed status that differs from the expected status gives `inconclusive` when observed is `inconclusive`, and `fail` otherwise; a missing required artifact or a missing final-state check gives `inconclusive`; otherwise the result is `pass`. When expected and observed are both `inconclusive`, the observed status equals the expected status, so the result is `pass` when every check holds.

**Expected-status recording (no schema change).** The first `observableStateChecks` entry is `observed status <x> matches expected <y>`, with `passed` true only when the two are equal. This entry is present only for completed runs (`pass`, `fail`, and `inconclusive` results). Skipped results, and infrastructure_error results other than a terminated run, have no checks and record the status in reason. A terminated run (status other than `completed`, a non-zero exit code, or a signal) keeps its recorded violations as failing checks. The `reason` states both statuses. A `skipped` result, or an `infrastructure_error` from a run that did not finish, has no observed status, and its `reason` records `observed status not observed`. A breached run that finished records its observed status in `reason`.

### Metrics and artifact gating

- Metrics for `pass` and `fail` come from the observed run. A journey record maps as follows: `handoffCount` is copied, `roleTransitions` become `from->to` strings, and `skillsInvoked` lists the skill IDs whose `loaded` is true. The journey record does not observe `humanInterventions`, `permissionAmbiguities`, `reviewDetectedDefects`, or `escapedDefects`; those are recorded as `0` and must not be read as measured zeros.
- For `skipped`, `infrastructure_error`, and `inconclusive`, every metric is zero or an empty array, and the `reason` says `metrics not observed`. A zero in these results is not a measurement.
- A `requiredArtifacts` entry is satisfied by an artifact path equal to it, or by one ending in `/` followed by it, so a run-directory prefix is allowed. A missing entry gives `inconclusive`.

### Repeatability

The normalizer removes `runId`, top-level `durationMs`, `evidence[].execution.durationMs`, the run-directory prefix of artifact paths, and a manifest's `createdAt`. The comparator reports whether two repeats are `repeatable`, with a field-level list of differences. The runner compares each later repeat with repeat 1, and each difference it records in `summary.json` carries `repeat`, the 1-based number of the later repeat that differs (so repeat 2 and repeat 3 are reported separately). It does not change any repeat's outcome: each repeat keeps the outcome its own facts produced, and a difference in `outcome` is reported as a difference.

### Isolation evidence and limits

An isolation evidence entry has `check.name` `isolation`, `check.category` `custom`, and `execution.basis` `re-run`. Its artifacts are the network record and a `network.enforcement=<netns|none>` value.

- `networkAllowed` false means that no outbound call succeeds. It does not mean that OpenCode never attempts one. The tolerated startup destination is not a breach.
- Local Windows runs are not hermetic. OpenCode 2.3.0 can still read skill directories from the real home, so Windows results are not authoritative for isolation. The Ubuntu `agent-e2e` CI job, which runs inside a network namespace, is the authority, as [ADR-0011](adr/0011-deterministic-agent-e2e-via-loopback-model-fixture.md) records.

## Runner

`npm run eval:opencode` runs the development scenarios that have a deterministic [scenario binding](glossary.md#evaluation-edd) through the agent E2E harness and writes evaluation results. The runner is `e2e/eval/runner.ts`, its command line is `e2e/eval/run.ts`, and the bindings are listed in `e2e/eval/bindings/index.ts`. The repeatability and violation checks are an opt-in on-demand run (`npm run eval:opencode:e2e`), not part of CI. Repeatability is shown for EDD-DEV-010 only (repeat 2); the other bound scenarios run at repeat 1. The run uses six OpenCode runs on Linux (five bound and one violation), and five on Windows.

```bash
npm run eval:opencode -- --set development --repeat 2 --out <dir>
```

- **Environment.** `HARNESS_E2E_OPENCODE` is the absolute path to the OpenCode 2.3.0 executable. `HARNESS_E2E_NETNS=1` also requires a loopback-only network namespace. When that check fails, no journey starts.
- **Skipped by default.** With `HARNESS_E2E_OPENCODE` unset, every scenario is `skipped` with the reason `OpenCode not configured`; `HARNESS_E2E_REQUIRE` is ignored in that case and every scenario is skipped. A scenario without a binding is always `skipped` with the reason `no deterministic binding; requires live mode`. Four development scenarios are bound: EDD-DEV-003, EDD-DEV-004, EDD-DEV-008, and EDD-DEV-010.
- **Availability failures.** A set `HARNESS_E2E_OPENCODE` that is empty, relative, not an existing file, or reports a version other than 2.3.0 makes each bound scenario `infrastructure_error`. So does a failed `HARNESS_E2E_NETNS` check. Nothing is launched in these cases.
- **Holdout.** The default set is `development`. `--set validation` must be requested explicitly and prints a holdout warning. Validation scenarios have no binding, so they are all `skipped`.
- **Live mode.** `--mode live` is rejected with a message and a non-zero exit. Only deterministic bindings run.
- **Repeats.** `--repeat` defaults to 2. Each repeat writes `run-manifest.json`, `result.json`, and `artifacts/` under `<dir>/<runId>/<scenarioId>/<repeat>/`, and each manifest and result is validated before it is written. Repeats are compared after normalization (see [Repeatability](#repeatability)). A difference makes the scenario non-repeatable. `summary.json` in the run directory records each scenario's outcomes, `repeatable`, and the differences, each tagged with its `repeat` number. The command line prints each difference as `repeat <n>: difference at <path>`.
- **Exit status.** 0 when every executed scenario passes and repeats. 1 when any repeat is `fail`, `inconclusive`, or `infrastructure_error`, when any scenario is non-repeatable, or when no scenario executed. A `skipped` result alone does not fail a run. 2 for a usage error: an unknown option or a missing or bad value, a `--repeat` that is not a positive safe integer, an unknown `--scenario`, or a `--scenario` ID from the other set (for example an `EDD-VAL-*` ID with the default development set). A usage error prints the usage text and writes no run directory.
- **Terminated runs.** An OpenCode run that times out, hits its idle timeout, exits non-zero, or ends on a signal is an `infrastructure_error` (see the [outcome rules](#outcome-model)). Its result records the run status, signal, and exit code, so `summary.json` and the result show why it was not judged.
- **Verdicts depend on the scripted fixture.** A binding's loopback steps are scripted turns, so a verdict shows what the fixture scripted and what the sandbox recorded, not model behaviour. EDD-DEV-008 runs `scripts/preflight.ts` against a stub gitleaks that writes malformed output. Its verdict is `pass` when preflight exits 2 and reports the secret-scan check as inconclusive, `fail` when preflight exits 0 or 1, and `inconclusive` when no usable preflight result is recorded. The stub needs a POSIX shell, so on Windows the binding is an `infrastructure_error`. The command is separate from `npm test` and `npm run smoke`. EDD-DEV-003 and EDD-DEV-010 are judge-style bindings: they report the sandbox's final state, not whether agents made the right decisions.

- **EDD-DEV-003** builds a local upstream commit in the sandbox and records it as `upstreamHead`. The judge passes only when the canonical checkout's HEAD and `origin/main`, and the linked task worktree's HEAD, all equal that commit and the commit is ahead of the HEAD before the run. A stale `origin/main` therefore fails the canonical check.
- **EDD-DEV-004** is a negative permissions scenario. Two sources must agree for an observed `fail` (the expected status): the Implementer's policy in `agents/implementer.md` resolves both `gh pr merge 1` and `git push origin HEAD` to `deny`, and the fixture recorded a tool result carrying the `permission.rejected` marker for each command. Without both recorded results the verdict is `inconclusive`. The marker is taken from the approved fix and is not yet observed in a real OpenCode 2.3.0 run. The remaining static-only limit is that the scripted turns are fixed, so the binding shows that the policy denies these commands and that the fixture recorded the denial, not that a model would choose them.
- **EDD-DEV-010** passes only when both modified files keep their exact pre-resume checksums. A file that is missing after the run counts as changed, so it fails the check; it is not an infrastructure error.
- **Unit tests.** `test/eval-judges.test.ts` covers `evaluateExecution()` and the four judges with synthetic journey runs and a table-driven sandbox. They check the judging logic only. They start no OpenCode process, so they are not evidence of real OpenCode behaviour, and real-binary evidence for these bindings is still pending.

## Live-model evaluation

This section is documentation only. No [LLM judge](glossary.md#evaluation-edd) and no live runner is implemented by this change, and nothing here authorizes one.

- **Separate runs.** A [live evaluation run](glossary.md#evaluation-edd) uses a rubric with `mode: live` (see [`eval/schemas/rubric.schema.json`](../eval/schemas/rubric.schema.json)) and its own output directory, separate from the deterministic [runner](#runner) output. Its run manifest records `mode: live`.
- **Not part of the gate.** Live evaluation runs are never part of CI or the deterministic gate. The [runner](#runner) rejects `--mode live` with a message and a non-zero exit.
- **Judge pinning.** A live rubric must include a `judge` block that pins the judge by `modelId` and `rubricVersion`. The rubric is versioned by its `version` field. A different judge model or a changed judge rubric is recorded as a different pin.
- **Calibration (procedure, not enforced).** The judge is calibrated against human-reviewed examples. These examples are kept outside the validation set (`eval/corpus/validation/`), and the calibration record is stored alongside the judge's rubric. The rubric field `judge.calibratedWithHumanExamples` is only a boolean. No tooling checks the examples, the calibration record, or whether calibration was done, so the flag is a claim, not evidence.
- **Access and reproducibility.** Live runs need model access. They are not reproducible by default: model output can differ between runs, so the deterministic [repeatability](#repeatability) comparison does not establish that a live result repeats.

## Development vs. validation corpus separation

The scenario corpus under `eval/corpus/` is strictly partitioned into two disjoint sets:

- **Development set (`eval/corpus/development/`):** Scenarios with IDs matching `EDD-DEV-NNN` (`set: "development"`). Used while iterating on prompts, skills, workflows, and adapters.
- **Validation set (`eval/corpus/validation/`):** Held-out scenarios with IDs matching `EDD-VAL-NNN` (`set: "validation"`). **Holdout rule:** do not consult or tune against validation scenarios while iterating on prompts, skills, or adapters; use them only to verify generalization.

The validator enforces that:

1. Every scenario's `set` matches its directory, its ID prefix (`EDD-DEV-` vs `EDD-VAL-`), and its filename (`<id>.json`).
2. All scenario IDs are globally unique across both sets (zero overlap), and normalized `title` and `stimulus.userPrompt` values do not duplicate across sets.
3. At least 20 scenarios exist across non-empty development and validation sets, covering both `positive` and `negative` cases for `approval`, `permissions`, `scope`, `tool-errors`, and `recovery`, as well as `roles`, `prompts`, `skills`, `workflows`, and at least one `adapter`.

## ID allocation, versioning, and scenario lifecycle

- **Next ID allocation:** Pick the next unused zero-padded integer in the target set (`EDD-DEV-NNN` or `EDD-VAL-NNN`) higher than all active IDs and all IDs listed in [`eval/corpus/retired.json`](../eval/corpus/retired.json). Never reuse a retired ID.
- **Semantic `version` bumps:** Bump `MAJOR` when `expectedOutcome`, `observableFinalState`, or `stimulus` semantics change; `MINOR` when adding non-breaking assertions or target tags; `PATCH` for typo or clarification edits.
- **Retirement and holdout integrity:** To retire a scenario, remove its file from `development/` or `validation/` and append its ID to `retiredIds` in `eval/corpus/retired.json`. `loadScenarioCorpus` validates `retired.json` and rejects any active scenario whose ID appears in `retiredIds`. Never move a `development` scenario into `validation`; new `validation` scenarios must be authored independently with distinct text and a fresh `EDD-VAL-NNN` ID.

## Adding reproducible incident scenarios

When a real workflow or host incident reveals a gap, add a reproducible scenario without leaking real data:

1. **Choose the target set:** Place exploratory regression cases in `eval/corpus/development/` (`EDD-DEV-NNN`) or held-out verification cases in `eval/corpus/validation/` (`EDD-VAL-NNN`).
2. **Use synthetic or sanitized data only:**
   - Replace real repository names, user handles, issue/PR numbers, commit SHAs, file paths, and hostnames with synthetic placeholders (for example `example-org/example-app`, `reviewer-user`, `#90001`, `0000000`).
   - Never include API keys, OAuth tokens, credentials, private URLs, or personal data.
   - Set `provenance.kind` to `"sanitized-incident"` (or `"synthetic"`) and `provenance.sanitized: true`.
   - Record a non-sensitive summary in `provenance.sourceSummary` (for example `"Derived from PR review line-anchor mismatch incident"`).
3. **Define observable final state:** Specify `expectedOutcome.observableFinalState` assertions describing the compliant state the runner must observe (Git status/branch, filesystem state, memory/receipt state, or external mutation count).
4. **Validate:** Run `npm run typecheck`, `npm test`, and `npm run docs:check` to verify JSON Schema validity, TypeScript validation, ID/content separation, and documentation links.
