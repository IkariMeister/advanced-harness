# Evaluation-Driven Development (EDD) v1

Advanced Harness uses **Evaluation-Driven Development ([EDD](glossary.md#evaluation-edd))** to verify agent behavior, role boundaries, prompts, [procedure skills](glossary.md#skills-and-commands), [workflow commands](glossary.md#skills-and-commands), and host adapters against a versioned [scenario corpus](glossary.md#evaluation-edd).

## Alignment with related issues

- **BH-034 (#62) — Deterministic loopback fixture:** Deterministic scenarios target a local loopback model fixture (`127.0.0.1`) with zero outbound network calls or API keys, recording role transitions, handoff counts, tool events, and skill invocations.
- **BH-050 (#125) — QA validation evidence:** Result evidence references and aligns with the [`evidence-collection`](../skills/evidence-collection/SKILL.md) format (`check`, `execution`, `output`, `artifacts`, `findingsSummary`).
- **BH-051 (#126) — ADR-002 role-consolidation protocol:** Run manifests and results record the [role setup](glossary.md#roles-and-agents) (`eight-role` baseline or pilot setups), host/model configuration, and evaluation metrics (defects, requirement coverage, rework/plan drift, handoffs, latency, token/model cost, evidence quality, permission ambiguities, human interventions).

## Versioned contracts (`schemaVersion: 1`)

All four contract schemas live in `eval/schemas/` and are validated by `src/eval-contracts.ts`:

| Contract | Schema | Example | Purpose |
| --- | --- | --- | --- |
| Scenario | [`eval/schemas/scenario.schema.json`](../eval/schemas/scenario.schema.json) | [`eval/examples/scenario.example.json`](../eval/examples/scenario.example.json) | Defines one versioned test scenario with preconditions, stimulus, expected outcomes, observable final state, and required evidence. |
| Rubric | [`eval/schemas/rubric.schema.json`](../eval/schemas/rubric.schema.json) | [`eval/examples/rubric.example.json`](../eval/examples/rubric.example.json) | Defines deterministic assertions and, for separate live runs, pinned judge versions and calibration references. |
| Run manifest | [`eval/schemas/run-manifest.schema.json`](../eval/schemas/run-manifest.schema.json) | [`eval/examples/run-manifest.example.json`](../eval/examples/run-manifest.example.json) | Records the evaluated host, role setup, model config, execution mode (`deterministic` or `live`), isolation config, and scenario IDs. |
| Evaluation result | [`eval/schemas/result.schema.json`](../eval/schemas/result.schema.json) | [`eval/examples/result.example.json`](../eval/examples/result.example.json) | Records per-scenario outcome (`pass`, `fail`, `skipped`, `inconclusive`, `infrastructure_error`), observable state checks, BH-050 evidence, and BH-051 metrics. |

## Development vs. validation corpus separation

The scenario corpus under `eval/corpus/` is strictly partitioned into two disjoint sets:

- **Development set (`eval/corpus/development/`):** Scenarios with IDs matching `EDD-DEV-NNN` (`set: "development"`). Used while iterating on prompts, skills, workflows, and adapters.
- **Validation set (`eval/corpus/validation/`):** Held-out scenarios with IDs matching `EDD-VAL-NNN` (`set: "validation"`). Used to check generalization and prevent overfitting to development examples.

The validator enforces that:

1. Every scenario's `set` matches both its directory and its ID prefix (`EDD-DEV-` vs `EDD-VAL-`).
2. All scenario IDs are globally unique across both sets (zero overlap).
3. At least 20 scenarios exist, covering both positive and negative cases for `approval`, `permissions`, `scope`, `tool-errors`, and `recovery`, as well as `roles`, `prompts`, `skills`, `workflows`, and at least one `adapter`.

## Adding reproducible incident scenarios

When a real workflow or host incident reveals a gap, add a reproducible scenario without leaking real data:

1. **Choose the target set:** Place exploratory regression cases in `eval/corpus/development/` (`EDD-DEV-NNN`) or held-out verification cases in `eval/corpus/validation/` (`EDD-VAL-NNN`).
2. **Use synthetic or sanitized data only:**
   - Replace real repository names, user handles, issue/PR numbers, commit SHAs, file paths, and hostnames with synthetic placeholders (for example `example-org/example-app`, `reviewer-user`, `0000000`).
   - Never include API keys, OAuth tokens, credentials, private URLs, or personal data.
   - Set `provenance.kind` to `"sanitized-incident"` (or `"synthetic"`) and `provenance.sanitized: true`.
   - Record a non-sensitive summary in `provenance.sourceSummary` (for example `"Derived from PR review line-anchor mismatch incident"`).
3. **Define observable final state:** Specify `expectedOutcome.observableFinalState` assertions (Git status/branch, filesystem state, memory/receipt state, or external mutation count) so the runner can verify actual state rather than relying only on agent self-reports.
4. **Validate:** Run `npm run typecheck`, `npm test`, and `npm run docs:check` to verify schema validity, ID separation, and documentation links.
