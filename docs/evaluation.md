# Evaluation-Driven Development (EDD) v1

Advanced Harness uses **Evaluation-Driven Development ([EDD](glossary.md#evaluation-edd))** to verify agent behavior, role boundaries, prompts, [procedure skills](glossary.md#skills-and-commands), [workflow commands](glossary.md#skills-and-commands), and host adapters against a versioned [scenario corpus](glossary.md#evaluation-edd).

## Alignment with related issues

- **BH-034 (#62) — Agent E2E suite on a loopback model fixture:** `npm run e2e:opencode` runs the real OpenCode 2.3.0 CLI through scripted journeys against a local loopback model fixture (`127.0.0.1`), with no live model or API keys. It does not execute the scenario corpus, and its journey record is not an evaluation result. The J3 skill journey is `todo`, tracked in #261, and the `agent-e2e` CI job has not yet run. See the [agent E2E guide](agent-e2e.md) and [ADR-0011](adr/0011-deterministic-agent-e2e-via-loopback-model-fixture.md). Mapping the journey record into evaluation results belongs to #226.
- **BH-050 (#125) — QA validation evidence:** Result `evidence` entries follow a compact `schemaVersion: 1` check/execution structure (`check.name`, `check.category`, `execution.command`, `execution.exitStatus`, `execution.durationMs`, `execution.basis`, and `artifacts` paths), while scenario `evidence.format` references `"evidence-collection-v1"` as the label for [`evidence-collection`](../skills/evidence-collection/SKILL.md) alignment.
- **BH-051 (#126) — ADR-002 role-consolidation protocol:** Run manifests record the [role setup](glossary.md#roles-and-agents) (`eight-role` baseline or [pilot role setup](glossary.md#evaluation-edd)), host, and model configuration; results record `handoffCount`, `roleTransitions`, `skillsInvoked`, `humanInterventions`, `permissionAmbiguities`, `reviewDetectedDefects`, `escapedDefects`, and optional `tokenCostUsd`.

## Versioned contracts (`schemaVersion: 1`)

All four contract schemas live in `eval/schemas/` and are validated by `src/eval-contracts.ts`:

| Contract | Schema | Example | Purpose |
| --- | --- | --- | --- |
| Scenario | [`eval/schemas/scenario.schema.json`](../eval/schemas/scenario.schema.json) | [`eval/examples/scenario.example.json`](../eval/examples/scenario.example.json) | Defines one versioned test scenario with preconditions, [stimulus](glossary.md#evaluation-edd), expected outcomes, observable final state, and required evidence. |
| Rubric | [`eval/schemas/rubric.schema.json`](../eval/schemas/rubric.schema.json) | [`eval/examples/rubric.example.json`](../eval/examples/rubric.example.json) | Defines deterministic assertions and, for separate live runs, pinned judge versions and calibrated criteria. |
| Run manifest | [`eval/schemas/run-manifest.schema.json`](../eval/schemas/run-manifest.schema.json) | [`eval/examples/run-manifest.example.json`](../eval/examples/run-manifest.example.json) | Records the evaluated host, role setup, model config, execution mode (`deterministic` or `live`), isolation config, and scenario IDs. |
| Evaluation result | [`eval/schemas/result.schema.json`](../eval/schemas/result.schema.json) | [`eval/examples/result.example.json`](../eval/examples/result.example.json) | Records per-scenario outcome (`pass`, `fail`, `skipped`, `inconclusive`, `infrastructure_error`), observable state checks, check/execution evidence, and recorded metrics. |

## Scenario polarity, expected status, and observable final state

- **`polarity` (`positive` | `negative`):** A `positive` scenario exercises compliant expected behavior; a `negative` scenario introduces a boundary, permission, scope, tool-error, or recovery violation that guardrails or evaluators must reject.
- **`expectedOutcome.status` (`pass` | `fail` | `inconclusive`):** Names the expected evaluation outcome for the scenario (`pass` when compliant behavior succeeds, `fail` when a negative violation is detected/rejected, `inconclusive` when a tool/ref error must stop without passing). A result's `outcome` is `pass` when the observed run matches `expectedOutcome.status` and satisfies every `expectedOutcome.observableFinalState` assertion.
- **`expectedOutcome.observableFinalState`:** Across both positive and negative scenarios, assertions state **the compliant state the runner must observe** at the end of a compliant/blocked run (for example, that an unapproved edit, destructive cleanup, or unauthorized push did not occur).
- **Result consistency:** In `eval/schemas/result.schema.json`, `pass` and `fail` results require non-empty `observableStateChecks` and `evidence`, while `skipped`, `inconclusive`, and `infrastructure_error` allow empty arrays when execution did not complete. A `pass` result is rejected if any `observableStateChecks` entry has `passed: false`.
- **Validator-only checks:** `rubric.schema.json` does not enforce unique `criteria[].id` values in JSON Schema itself (`validateRubric` enforces uniqueness in TypeScript), and `run-manifest.schema.json` checks `createdAt` shape only while `validateRunManifest` also verifies real calendar/time validity.

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
