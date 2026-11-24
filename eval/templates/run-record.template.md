# BH-051 Evaluation Run Record Template

Use this template for live pilot runs, Android workflow runs, and manual evaluations under [the role-consolidation evaluation protocol](../../docs/role-consolidation-evaluation.md). Store structured companion data using [the run-record schema](../schemas/run-record.schema.json) and [the JSON template](run-record.template.json).

A measured `0` is a valid observed value. For unobserved, waived, or telemetry-unavailable metrics, record `not-observed` or `unknown` in `metricObservation` and `supplementaryMetrics`, while keeping `#225`-required `result.metrics` fields at placeholder `0` or `[]`. Use `recordKind: "template"` only for unfilled templates, and never treat a configured model label as verified runtime model usage.

## 1. Run Identification & Attribution

- **Record ID:** `<unique-id>`
- **Record kind:** `baseline` | `candidate` | `template`
- **Baseline reference (if `candidate`):** `<baseline-record-id>`
- **Protocol version:** `1.0.0`
- **Repository commit & harness version:** `<sha>` (`<version>`, dirty: `yes` | `no`)
- **Task / Scenario IDs & versions:** `<issue/task ID or EDD-DEV-NNN@x.y.z>`
- **Executed by:** `<human name or agent identifier>` (`human-interactive` | `agent-assisted` | `ci-automated`)
- **Authorized by (required if agent-assisted):** `<human handle>`
- **Run timestamp (UTC):** `<YYYY-MM-DDTHH:MM:SSZ>`

## 2. Host, Role Setup & Model Configuration

- **Host & version:** `<opencode | claude-code | antigravity | codex | cursor>` (`<version>`)
- **OS & isolation:** `<OS>` (`networkEnforcement`: `netns` | `none` | `not-applicable`, `hermetic`: `yes` | `no`)
- **Role setup:** `eight-role` | `engineer-pilot` | `operations-pilot`
- **Execution mode & rubric:** `deterministic` | `live` (`<rubricId>@<rubricVersion>`, judge `<modelId>` if live)
- **Configured per-role models / tiers / variants:**

| Role | Configured model / tier / variant | Observed runtime model | Verification evidence / status |
| --- | --- | --- | --- |
| Lead | `<configured>` | `<observed or unverified>` | `<verified source / unverified>` |
| Planner | `<configured>` | `<observed or unverified>` | `<verified source / unverified>` |
| Researcher / Implementer / Engineer | `<configured>` | `<observed or unverified>` | `<verified source / unverified>` |
| Reviewer | `<configured>` | `<observed or unverified>` | `<verified source / unverified>` |
| QA (or validation skills) | `<configured>` | `<observed or unverified>` | `<verified source / unverified>` |
| Operator / External / Operations | `<configured>` | `<observed or unverified>` | `<verified source / unverified>` |

## 3. BH-048 Host Permission Prerequisites (`docs/host-permission-capabilities.md`)

| Boundary | Status on host | Relevance to this run |
| --- | --- | --- |
| Read-only before approval, write/execute after approval | `enforced` \| `advisory` \| `unsupported` \| `unverified` | `<e.g., required for Engineer pilot>` |
| Local Git vs. external/remote isolation | `enforced` \| `advisory` \| `unsupported` \| `unverified` | `<e.g., required for Operations pilot>` |
| Command execution scoped per role | `enforced` \| `advisory` \| `unsupported` \| `unverified` | `<e.g., Reviewer/QA re-run vs evidence-only>` |
| Skills / MCP exposure scoped per role | `enforced` \| `advisory` \| `unsupported` \| `unverified` | `<notes>` |
| Actual per-role model routing | `enforced` \| `advisory` \| `unsupported` \| `unverified` | `<e.g., required for BH-055 tier evaluation>` |

## 4. Representative Task Classification & Criteria

- **Task class(es):** `routine-implementation` | `research-then-implementation` | `architecture` | `qa-visual` | `local-external-operations`
- **Methodology mode & rigor (if selected):** `<RDD | SDD | ODD | HYBRID | unspecified>` / `<minimal | standard | strict | unspecified>`
- **Task / acceptance criteria:**
  1. `<Criterion 1>`
  2. `<Criterion 2>`

## 5. Outcomes & BH-051 Metrics

- **Outcome:** `pass` | `fail` | `inconclusive` | `skipped` | `infrastructure_error`
- **Repeatability (if deterministic or repeated):** `<repeats run, matching yes/no, differences>`

| Metric | Value / Status | Observation basis (`measured` / `not-observed` / `unknown`) | Notes |
| --- | --- | --- | --- |
| Review-detected defects (`reviewDetectedDefects`) | `<count or status>` | `<basis>` | `<severity breakdown>` |
| Escaped defects (`escapedDefects`) | `<count or status>` | `<basis>` | `<post-review / post-merge defects>` |
| Requirement coverage (`requirementCoverage`) | `<met/total or status>` | `<basis>` | `<unmet criteria>` |
| Rework / plan drift (`reworkCycles`, `planDriftCount`) | `<counts or status>` | `<basis>` | `<notes>` |
| Handoff count (`handoffCount`) | `<count or status>` | `<basis>` | `<completed delegations>` |
| Role transitions (`roleTransitions`) | `<sequence or count>` | `<basis>` | `<e.g., lead->operator>` |
| Skills invoked (`skillsInvoked`) | `<list or status>` | `<basis>` | `<loaded true/false>` |
| Context reconstruction (`contextReconstructionCount`) | `<count or status>` | `<basis>` | `<re-discovery events>` |
| Latency (`durationMs` / wall time) | `<ms or status>` | `<basis>` | `<per-repeat or end-to-end>` |
| Token usage & cost (`tokenUsage`, `tokenCostUsd`) | `<tokens / USD or unknown>` | `<basis>` | `<pricing basis or why unknown>` |
| Evidence quality (`evidenceQuality`) | `<summary or status>` | `<basis>` | `<re-run vs judged from evidence only>` |
| Permission ambiguities (`permissionAmbiguities`) | `<count or status>` | `<basis>` | `<prompts/denials/unclear boundaries>` |
| Planned approval gates (`plannedApprovalGates`) | `<count or status>` | `<basis>` | `<expected plan/pub/merge gates>` |
| Unplanned human interventions (`humanInterventions`) | `<count or status>` | `<basis>` | `<clarifications, rescues, interruptions>` |

## 6. Checks, Evidence & Artifacts

| Check / Step | Command | Exit status | Basis (`re-run` / `judged from evidence only`) | Artifact path(s) (sanitized) |
| --- | --- | --- | --- | --- |
| `<check>` | `<command>` | `<exit>` | `<basis>` | `<artifacts/...>` |

## 7. Limitations, Waivers & Comparison Notes

- **Limitations & non-claims:**
  - `<What this run does NOT prove (host limitations, unverified model routing, missing telemetry, non-hermetic environment)>`
- **Explicit waivers (if any):**
  - `<Waived scope, human approver, reason, reference — waived is never passed>`
- **Candidate comparison & disposition (if `candidate`):**
  - `<Equivalence check against baseline, improvements, regressions (highlight critical regressions), next decision>`
