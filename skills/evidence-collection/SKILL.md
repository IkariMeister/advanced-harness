---
schemaVersion: 1
name: evidence-collection
description: Collect execution commands, outputs, and artifacts for review evaluation.
intendedRoles:
  - implementer
  - reviewer
  - qa
---
# Evidence collection

Collect and record reproducible validation evidence across unit tests, static analysis, and verification checks into a standardized format that Reviewer can evaluate without mandatory re-running.

## Invariants and boundaries

- **Procedural only:** This skill standardizes the structure of captured evidence. It does **not** evaluate findings, decide whether results are acceptable, waive requirements, or make accept/discard decisions.
- **Tree protection:** Evidence records and artifacts must be stored in disposable scratch locations, build output folders, or external evidence sinks. Never commit transient evidence logs or clutter reviewed working trees.
- **Reviewer independence:** The unified record enables Reviewer to distinguish between checks **re-run** and checks **judged from evidence only**, per ADR-002 and Reviewer rubric requirements.

## Unified evidence format

Every validation check must record evidence with the following schema:

```yaml
schemaVersion: 1
check:
  name: <string; e.g. "unit-tests", "linter", "type-check">
  category: <"unit-tests" | "static-analysis" | "build" | "e2e" | "custom">
execution:
  command: <string; exact command executed>
  cwd: <string; working directory where executed>
  timestamp: <ISO 8601 timestamp>
  durationMs: <number>
  exitStatus: <number; process exit code>
  basis: <"re-run" | "judged from evidence only">
output:
  stdout: <string; captured stdout stream or reference path>
  stderr: <string; captured stderr stream or reference path>
artifacts:
  - path: <string; path to generated artifact, e.g. coverage report or log>
    description: <string; description of artifact content>
findingsSummary:
  totalIssues: <number>
  errors: <number>
  warnings: <number>
```

## Collection procedure

1. **Pre-execution setup:**
   - Determine target disposable output path for raw logs and execution metadata.
2. **Execute and observe:**
   - Execute the validation command under observation, recording exact arguments, execution timing, and exit status.
3. **Serialize evidence:**
   - Capture stdout and stderr streams. If logs are large, persist raw logs into a disposable artifact directory and record relative or absolute artifact paths.
   - Populate the standardized evidence record with exact exit status and execution basis.
4. **Handoff to Reviewer:**
   - Provide the serialized evidence to Lead/Reviewer.
   - Reviewer evaluates the evidence directly, or requests a re-run from an authorized command-running role if execution evidence is missing or inconclusive.
