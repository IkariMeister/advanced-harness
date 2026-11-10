# ADR: Project Guardrail Policy Lives in Project Context and Is Read From the Trusted Ref

**Status:** Proposed\
**Date:** 2026-11-10\
**Project:** Advanced Harness\
**Decision scope:** Where a project's [preflight policy](../glossary.md#workflow-and-tracking) is stored, which copy takes effect, and how the policy relates to the built-in checks.

## Context

[ADR-005](0005-preflight-scope-and-redaction.md) keeps the path rules configurable by project, but preflight had no project-level configuration: the only override was a programmatic option. Projects need to adjust their guardrails (for example, to block or downgrade a check, or to add forbidden globs) and need the adjustment to be reviewable.

The policy is a guardrail. A worktree can change its own files, so a policy read from the worktree could be weakened in the same changeset that preflight inspects. The policy therefore needs an anchor that the change under inspection cannot alter. The anchor used for project context is the [trusted ref](../glossary.md#workflow-and-tracking), `refs/remotes/origin/HEAD`, read locally without fetching.

## Decision Drivers

1. A task cannot weaken the guardrails that inspect it. The effective policy comes from outside the changeset.
2. Settings stay in project context, next to the project's other settings, not in a separate machine-local file.
3. The built-in checks stay fixed where they are the safety net. Only the path check is configurable.
4. Absence means today's behavior. Nothing is inferred or migrated.
5. A policy is evidence configuration. It never approves work or publication.

## Considered Options

### A. A key in the `project` profile

The policy would be a field of the existing `project` settings. This keeps one section, but it mixes guardrails into the setup profile that `harness:setup` rewrites. It also puts the policy into the global project defaults shape, which only suggests values. Rejected.

### B. A separate `preflight` section in the same context file (chosen)

The policy sits in its own marked section of `AGENTS.md`, or of the `--context` file it links to. It is validated on its own, and setup can leave it unchanged when the human does not opt in. It keeps the existing context model: the section is shared across hosts and is read like the other sections.

### C. A separate JSON file

A file such as `.opencode/harness.preflight.json` would be simple to read. It adds a second config location beside the legacy profiles that the harness is moving away from, and it needs its own receipt, trust, and ownership rules. It does not remove the need to anchor the policy to the trusted ref. Rejected.

### D. Read the policy from the worktree

This matches the other context settings and needs no trusted ref. It lets a changeset weaken the checks that inspect it, which is the failure this decision must prevent. Rejected. A worktree copy is still compared with the trusted one, and any difference is reported as a warning.

## Decision

1. **Location.** A project's preflight policy is a marked `preflight` section (`<!-- advanced-harness:preflight:start -->` to `<!-- advanced-harness:preflight:end -->`) in the same context file as the `project` section. It is not part of the `project` profile and not part of the global project defaults. Global values are code-level suggestions only (`DEFAULT_PREFLIGHT_POLICY`).
2. **Schema.** `version: 1` with optional `checks` (configurable check id to `enabled` and `severity`), `forbiddenGlobs` (`add` or `replace`), `prodGlobs` and `testGlobs` (set together), and `allowlistPath`. Unknown keys are rejected at every level. There is no base-ref key: the base ref stays `baseBranch` in project context, or `--base`.
3. **Checks.** Configurable checks are those marked configurable on the registered check. Only `path-policy` is configurable. The fixed checks (`changeset`, `base-context`, `policy`, `secret-scan`, `worktree-boundary`) cannot be disabled, downgraded, or named as configurable. A `block` may become `warn` and a `warn` may become `block`. `pass` and inconclusive results never change.
4. **Trust.** The effective policy is always read from the trusted ref `refs/remotes/origin/HEAD`, with or without `--base`, using the same AGENTS.md or link resolution as the base-context check. A worktree copy that differs in any way is reported as `warn`, and takes effect only after it reaches origin/HEAD. If the trusted ref is unavailable and the worktree records a policy, the result is inconclusive. If the trusted ref is unavailable and the worktree records none, behavior is unchanged. There is no CLI flag and no environment override.
5. **Evidence.** A built-in `policy` result is always reported. It states the source, disabled checks, severity overrides, any worktree difference, and recorded keys that no installed check consumes yet. Such keys are reported as recorded but not enforced, so a policy that enforces nothing does not look enforced.
6. **Allowlist.** `allowlistPath` is resolved in the worktree. Links and junctions are refused at any level, and the file must be regular, at most 1 MiB, and inside the worktree after realpath. Its entry format belongs to a later decision (BH-068).

## Consequences

**Positive:** A changeset cannot weaken the checks that inspect it. Project settings stay in the context file that already holds the project's other settings. Absence keeps today's behavior, and the policy result makes the effective configuration visible.

**Negative:** A new or changed policy takes effect only after it reaches origin/HEAD, so until then preflight reports a warning. Projects without a configured origin/HEAD cannot use a worktree-only policy. Reading the trusted ref depends on the local clone's `origin/HEAD`. An unreadable, symlinked, or oversized context file, in the worktree or at the trusted ref, makes every check inconclusive even when `--base` is given. This is a change from before: `--base` used to skip the context read, so those files did not affect a run that passed `--base`.

**Neutral:** Configurable checks are a small, explicit set. Adding a configurable check is a code change that marks the check, not a schema change.

## Adoption

Accepting this ADR does not change tooling, roles, permissions, or defaults. The implementation is a separate, human-approved plan for BH-069 (#184). It covers the schema and loader, the trusted-ref helpers shared with base-context, path-policy's use of `forbiddenGlobs`, the setup opt-in, and the documentation. Rollback reverts those implementation changes. It does not modify machine configuration. Projects that never add a `preflight` section see no change apart from the new `policy` result line.

## Reconsideration

Reopen this decision when either condition below is observed:

- **origin/HEAD is unreliable as an anchor.** For example, projects frequently cannot set or keep `origin/HEAD`, use a remote other than `origin`, or see the local ref lag far behind the real default branch often enough that the trusted policy is routinely stale or unavailable. Then the anchor needs to change, for example to a pinned or explicitly configured reference.
- **Compatibility with older harness versions is no longer a concern.** Once every consumer runs a release that understands the `preflight` section, the `project` profile could carry the policy, which would remove the separate section.

This ADR is reviewed at each milestone close.

## References

- [ADR-005: Preflight scope, redaction, and secret scanning](0005-preflight-scope-and-redaction.md)
- [Preflight guide](../preflight.md#project-policy)
- [Global connections and project context](../configuration.md#preflight-policy)
- [Project setup](../project-setup.md#what-setup-asks)
