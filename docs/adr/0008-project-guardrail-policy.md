# ADR: Project Guardrail Policy in `.harness/preflight.json`, Read From origin/HEAD

**Status:** Proposed\
**Date:** 2026-11-12\
**Project:** Advanced Harness\
**Decision scope:** Which built-in preflight checks a project may enable, disable, or re-severity; how the policy is stored, read, and reported; and how forbidden-path globs combine with the built-in list.

## Context

[ADR-007](0007-preflight-scope-and-redaction.md) keeps the path rules configurable by project, but preflight had no project-level configuration: the only override was a programmatic option. Projects need to adjust their guardrails, for example to downgrade `path-policy` to a warning or to add forbidden globs, and the adjustment must be reviewable.

The policy is a guardrail. A worktree can edit its own files, so a policy read from the worktree could be weakened in the same changeset that preflight inspects. The policy therefore needs an anchor that the change under inspection cannot alter. The anchor is the [trusted ref](../glossary.md#workflow-and-tracking), `refs/remotes/origin/HEAD`, read locally without fetching.

## Decision Drivers

1. A task cannot weaken the guardrails that inspect it. The effective policy comes from outside the changeset.
2. The built-in checks that protect the review stay fixed. Only checks where configuration is safe are configurable.
3. A policy is evidence configuration. It never approves work or publication.
4. Absence means today's behavior. Nothing is inferred or migrated.
5. A configuration that enforces nothing must not look enforced.

## Considered Options

### A. Store the policy in the `project` profile

The policy would be a field of the existing project settings. This mixes guardrails into the setup profile that `harness:setup` rewrites, and it would put the policy into the global project defaults shape, which only suggests values. Rejected.

### B. A marked section in the project context file

The policy would sit in its own marked section of `AGENTS.md`, or of the context file it links to. The section would be validated on its own and shared across hosts. This option is not chosen, for three reasons:

- **Coupling to setup.** `--context` selects where `harness:setup` writes project settings; it is a setup-write option only. Preflight does not take it and finds the context through the `AGENTS.md` link. A policy stored in the context file would therefore follow the context chosen at setup and the link, not the repository.
- **Mixing with the setup-owned profile.** The section would sit beside the project settings that `harness:setup` rewrites, so one file would carry both setup-owned settings and guardrails.
- **Dependence on link resolution.** The policy's location would depend on how the `AGENTS.md` link resolves, which is a property of the context rather than of the repository. A fixed path under `.harness/` does not depend on it.

### C. A separate JSON file under `.harness/` (chosen)

The policy lives in `.harness/preflight.json` at the repository top level. It is independent of `--context`, is read from `refs/remotes/origin/HEAD` with or without `--base`, and travels with the repository once committed. A machine-local file such as `.opencode/harness.preflight.json` would need its own receipt, trust, and ownership rules and would not be anchored to the trusted ref.

### D. Read the policy from the worktree

This needs no trusted ref, but it lets a changeset weaken the checks that inspect it, which is the failure this decision must prevent. Rejected. A worktree copy that differs from the trusted one is reported by `policy-integrity` as a review blocker.

## Decision

1. **Location and schema.** The policy is `.harness/preflight.json`, with optional `version` (1 or omitted), `checks`, `forbiddenPathGlobs`, `prodGlobs` and `testGlobs` (set together or not at all), and `gitlinkAcknowledgements`. Unknown keys are rejected at every level, including inside `checks.<id>` and the `forbiddenPathGlobs` object, and duplicate keys are rejected rather than resolved to the last value. The justified secret exceptions remain in `.harness/preflight-allowlist.json`, which has the same duplicate-key rule.
2. **Fixed and configurable checks.** The fixed checks are `changeset`, `base-context`, `policy-integrity`, `policy`, `secret-scan`, and `worktree-boundary`. They cannot be disabled, re-severitied, or named under `checks`. `policy-integrity` always reports a changed policy file as a review blocker. The configurable set is `path-policy` only. A configuration entry may set `enabled` (a boolean) and `severity` (`block` or `warn`) on a configurable check.
3. **Severity.** Severity applies only to a built-in configurable check instance, never by ID or by a field that a caller-supplied check sets. It changes `block` to `warn` and `warn` to `block`. `pass` and `inconclusive` are never changed. Custom checks are not affected by the policy's severity or disable settings, and they may run beside a policy file.
4. **Policy result.** A fixed `policy` result is always reported. It states the source (file, trusted ref, and commit), disabled checks, severity overrides, the forbidden-glob mode and count, and any programmatic override. It returns `warn` when a recorded key is not enforced by any installed check: `prodGlobs` and `testGlobs` today, and `forbiddenPathGlobs` while `path-policy` is disabled.
5. **Forbidden-path globs.** An array in the file, or `{"mode": "replace", "globs": [...]}`, replaces the built-in list. `{"mode": "add", "globs": [...]}` keeps the built-in list and appends to it. Globs must be safe repository-relative strings.
6. **Trust anchor.** The effective policy is always read from `refs/remotes/origin/HEAD`, with or without `--base`. `--base` selects only the changeset comparison. A missing ref is inconclusive for policy-dependent checks, and so is any other Git failure reading it. This is consistent with [ADR-007](0007-preflight-scope-and-redaction.md), which states the same rule.
7. **Setup.** Setup offers the default policy once, and only in a Git checkout without a valid existing file. Only the answer `policy` adds it. Setup writes `.harness/preflight.json` at the repository top level regardless of `--context`.

## Consequences

**Positive:** A changeset cannot weaken the checks that inspect it. Configuration stays small and explicit, and the policy result makes the effective configuration visible, including any recorded key that enforces nothing.

**Negative:** A new or changed policy takes effect only after it reaches `origin/HEAD`. Until then preflight reports the difference through `policy-integrity` and the worktree copy is not used. Projects without a configured `origin/HEAD` cannot use a policy file at all, and their policy-dependent checks are inconclusive.

**Neutral:** Configurable checks are a small, explicit set. Adding a configurable check is a code change that registers its built-in instance, not a schema change. `prodGlobs` and `testGlobs` are reserved for BH-070 and are recorded without effect in this release.

## Adoption

This ADR is delivered with its implementation for BH-069 (#184) in the same change, after the human approved the plan. The implementation covers the schema and loader, the trusted-ref helper shared with base-context and worktree-boundary, the policy result, the setup opt-in, and the documentation. Rollback reverts those implementation changes. It does not modify machine configuration. Projects that never add `.harness/preflight.json` see no change apart from the new `policy` result line.

## Reconsideration

Reopen this decision when either condition below is observed:

- **origin/HEAD is unreliable as an anchor.** For example, projects frequently cannot set or keep `origin/HEAD`, use a remote other than `origin`, or see the local ref lag so far behind the default branch that the trusted policy is routinely stale or unavailable. Then the anchor needs to change, for example to a pinned or explicitly configured reference.
- **Configurable checks need more than enable and severity.** If projects routinely need per-check options beyond enabled and severity, the schema needs a new decision rather than more keys under `checks`.

This ADR is reviewed at each milestone close.

## References

- [ADR-007: Preflight scope, redaction, and secret scanning](0007-preflight-scope-and-redaction.md)
- [Preflight guide](../preflight.md#project-policy-and-revision-authority)
- [Configuration guide: Preflight policy](../configuration.md#preflight-policy)
- [Project setup](../project-setup.md#what-setup-asks)
