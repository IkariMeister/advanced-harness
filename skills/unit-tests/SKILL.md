---
schemaVersion: 1
name: unit-tests
description: Execute configured unit tests and capture outputs and artifacts.
intendedRoles:
  - implementer
  - reviewer
  - qa
---
# Unit tests

Execute configured unit test suites to verify component behavior, capture reproducible execution evidence, and ensure test outputs do not dirty the working tree.

## Invariants and boundaries

- **Procedural only:** This skill describes reproducible execution of unit test suites and artifact capture. It does **not** evaluate pass/fail criteria, decide whether results are acceptable, or authorize fixes or merges.
- **Tree cleanliness:** Tests must run non-destructively. Any check that generates temporary files, test reports, or coverage data must use a disposable directory or another method that leaves the reviewed source tree unchanged.
- **Role usage:**
  - **Implementer:** Runs unit tests for self-verification before requesting review and attaches structured execution evidence.
  - **Reviewer:** Inspects recorded test evidence or selectively re-runs tests when the host permits command execution.
  - **QA:** Executes configured test suites as part of holistic validation procedures.

## Execution procedure

1. **Prerequisites check:**
   - Confirm required runtimes, build tools, and dependencies are available without modifying system configuration.
   - If test dependencies or commands are missing or unconfigured, report the blocker to Lead rather than guessing commands or modifying environment configurations.
2. **Execute test suite:**
   - Run the project's configured unit test command (e.g., `npm test`, `./gradlew test`, or `pytest`).
   - Run tests against the clean target worktree or commit.
3. **Capture outputs:**
   - Record exact command invocations, working directory, start/end timestamps, exit status, and raw stdout/stderr streams.
4. **Preserve artifacts:**
   - Write test summaries, coverage reports, or logs to a disposable artifact location (such as temporary directories or designated non-tracked output paths).
   - Format recorded evidence using the `evidence-collection` skill format so that Reviewer can judge results without mandatory re-runs.
