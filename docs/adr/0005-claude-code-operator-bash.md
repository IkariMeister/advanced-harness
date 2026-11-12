# ADR: Give Operator Bash on Claude Code With Advisory Remote-Git Denies

**Status:** Proposed\
**Date:** 2026-11-09\
**Project:** Advanced Harness\
**Decision scope:** The Claude Code tool mapping for Operator and how its shell deny patterns are represented. Other hosts, other roles, and Operator's source policy are out of scope.

## Context

The Operator contract owns local Git and task worktree creation through native shell (ADR-004 bootstrap step 4). The Claude Code compiler is fail closed: a role whose shell policy has deny patterns gets no Bash, because Claude Code cannot scope Bash patterns per subagent. Project settings rules apply to every session and subagent, so they cannot target Operator alone.

Operator's source policy denies `git push *`, `git pull *`, `git clone *`, `gh *`, and the `git fetch` forms that run upload-pack or update-head-ok (`git fetch *--upl*`, `git fetch -u*`, `git fetch * -u*`). Operator therefore had no Bash on Claude Code, and `/start-issue` could not create a task worktree there (#200). Workarounds routed local Git through External as per-task exceptions, which blurs the Operator/External split that ADR-002 keeps.

## Decision Drivers

1. `/start-issue` on Claude Code creates the task worktree through the role that owns it, or stops with a documented fallback.
2. No role other than Operator gains Bash; fail-closed handling stays the default for every other role and pattern.
3. Deny rules that are safe for every role are enforced in project settings; the rest are disclosed as advisory, not presented as enforced.
4. External keeps its remote Git and `gh` capabilities.
5. The change is reversible by a code revert and `harness:update`.

## Considered Options

### A. Keep Operator without Bash

No new risk, but bootstrap stays broken on Claude Code and local Git keeps moving to External by exception. Rejected.

### B. Give Operator Bash; enforce what project settings can safely deny for every role, and disclose the rest as advisory (chosen)

Bootstrap works through Operator. The remote Git and `gh` denies become instruction-only on Claude Code, and the mapping is not an exact per-role scoping. This meets drivers 1, 2, 3, 4, and 5.

### C. Project-wide deny of all Operator patterns

Project settings would block every Operator pattern for every session, including External's `git push` and `gh`. Rejected, because it breaks External's remote Git and `gh` work (driver 4).

### D. Per-role enforcement through a hook or subagent-scoped mechanism

This might be exact, but this harness has not verified it on Claude Code, and it adds infrastructure. Deferred; see Reconsideration.

## Decision

1. The compiler grants Operator the whole Bash tool through one explicit, role-keyed exception that lists Operator's current shell deny patterns. The exception applies only while Operator's shell denies exactly match the listed set and its base shell effect is `ask`. Any missing or extra deny pattern, any other role, or a different base effect withholds Bash. A missing listed deny is reported as unsupported.
2. `git fetch *--upl*`, `git fetch -u*`, and `git fetch * -u*` become project settings deny rules for every session and subagent. Destructive Git stays denied.
3. `git push *`, `git pull *`, `git clone *`, and `gh *` are advisory for Operator on Claude Code. They are stated in the Operator contract and disclosed by install, doctor, the Lead block, and the capability matrix as not enforced.
4. No allow rule is emitted. Operator Bash calls use Claude Code's default prompts. A permission prompt is tool authorization, not plan approval, and it never authorizes a command that is advisory-denied.
5. If Operator's Bash is not offered, or is denied or declined at runtime, bootstrap stops with `Needs your decision`. The human creates the worktree or cancels. There is no role substitution.
6. Implementer, Reviewer, QA, and Lead keep no Bash on Claude Code.

## Consequences

**Positive:** Bootstrap works through Operator. External stops receiving local Git exceptions. The remaining gap is disclosed precisely.

**Negative (residual risk):** Operator could run `gh`, `git push`, `git pull`, `git clone`, or other network commands despite its instructions. Only its contract and Claude's prompt stand in the way, and a user-level allow rule or a permission-bypassing mode removes the prompt. Local/remote isolation on Claude Code is advisory, so the Operations consolidation (ADR-002) remains unmet on this host. The project-wide `git fetch` denies also apply to External and, for a global install, to every project.

**Neutral:** Operator's source policy and other hosts are unchanged. The capability matrix moves Claude Code local/remote isolation from unsupported to advisory, never to enforced.

## Adoption

Accepting this ADR changes no tooling or permissions by itself. The change that implements it updates the compiler, the disclosures, the Operator contract, `/start-issue`, the documentation, and the tests. Installed projects pick it up with `harness:update --host claude-code`.

Rollback is a revert of that change followed by `harness:update --host claude-code`. Receipt-managed settings, agent files, and the Lead block are rewritten.

## Reconsideration

- A per-role Claude Code mechanism is verified to block Operator's remote commands. That would supersede Decision 3 and could replace the exception in Decision 1.
- Recorded outcomes show Operator running remote Git or `gh` on Claude Code.
- Operator's source shell denies change. The exception applies only while they exactly match the listed set; any missing or extra deny pattern withholds Bash, so a change to that set needs this ADR reviewed or a superseding ADR.

This decision is also reviewed at each milestone close.

## References

- Issue #200, Operator bootstrap on Claude Code.
- [ADR-002](0002-consolidate-agent-responsibilities.md): Operations consolidation and host capability evidence.
- [ADR-004](0004-canonical-checkout-remote-updates-only.md): bootstrap step 4, creating the task worktree.
- [Host permission capability matrix](../host-permission-capabilities.md).
- [src/claude-code-compiler.ts](../../src/claude-code-compiler.ts) and [test/claude-code-compiler.test.ts](../../test/claude-code-compiler.test.ts).
- [agents/operator.md](../../agents/operator.md).
