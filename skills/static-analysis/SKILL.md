---
schemaVersion: 1
name: static-analysis
description: Run configured linters and static checks in non-mutating check mode.
intendedRoles:
  - implementer
  - reviewer
  - qa
---
# Static analysis

Execute configured static analyzers, linters, and type checkers to detect code quality issues, syntax errors, and style regressions without modifying files.

## Invariants and boundaries

- **Procedural only:** This skill describes reproducible execution of static analysis tools and diagnostics capture. It does **not** decide whether results are acceptable, evaluate findings, prioritize issues, or authorize automatic fixes.
- **Non-mutating mode:** Linters and formatters must run in check-only mode (such as read-only lint checks, `--check`, or dry-run flags). Never invoke tools in auto-fix or in-place format mode during analysis.
- **Tree cleanliness:** Analyzers that produce cache files, intermediate outputs, or reports must store them in disposable or ignored build directories to avoid dirtying the reviewed tree.
- **Role usage:**
  - **Implementer:** Runs static analysis for self-verification to ensure zero regressions before review.
  - **Reviewer:** Judges recorded linter and analyzer outputs, verifying whether reported diagnostics or warnings are resolved.
  - **QA:** Runs static analysis as part of automated quality verification pipelines.

## Execution procedure

1. **Identify configured analyzers:**
   - Identify project-configured linters, type checkers, and static verification tools (e.g., ESLint, TypeScript `tsc --noEmit`, Detekt, Spotless check, flake8).
   - Verify tool availability; if configuration or tools are missing, report to Lead rather than inventing rules or configurations.
2. **Execute analyzers in read-only mode:**
   - Run each analyzer with strict non-modifying arguments.
   - Prevent background modification of source code or baselines.
3. **Capture diagnostics:**
   - Capture command line, tool version, exit status, stdout, stderr, and line-level diagnostic findings (file path, line number, rule ID, severity message).
4. **Record evidence:**
   - Record results following the standard `evidence-collection` format so that Reviewer can evaluate static analysis status without re-running.
