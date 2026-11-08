# ADR: Keep the Canonical Checkout Read-Only Except for Remote Updates

**Status:** Proposed\
**Date:** 2026-11-08\
**Project:** Advanced Harness\
**Decision scope:** Git ownership of an application repository's canonical checkout during task bootstrap, and how that ownership is enforced. It covers the application repository only.

## Context

Task bootstrap creates an isolated task worktree from the base branch. Until now, the Operator contract said that "untouched canonical changes do not block bootstrap" and that, if `git fetch` failed, the role should "branch from the local base". Nothing required the canonical checkout to be on the base branch or up to date. A task could therefore start from a stale or divergent local base, and edits or commits could accumulate in the canonical checkout outside any task worktree. Issue #172 asks for the canonical checkout to receive only remote updates.

Enforcement is the hard part. Shell permission patterns cannot bind a grant to a particular worktree path, as [worktree-permission-proposal.md](../worktree-permission-proposal.md) explains. A harness-installed Git hook could enforce the rule locally, but it would write local Git configuration and would need consent and install, update, and uninstall handling. Those costs are not justified in this change.

## Decision Drivers

1. Agents must not change the history or working state of the canonical checkout outside a task worktree.
2. Tasks must start from the current remote base, not a stale or divergent local base.
3. No permission broadening, and no silent repair of a checkout in an unknown state.
4. Single-checkout projects must not be affected.
5. The rollout must be a reversible text change.

## Considered Options

### A. Keep the current contract

Untouched canonical changes do not block bootstrap; `git fetch` is optional, and a failed fetch falls back to the local base. This is the smallest change and keeps the current behavior. It does not meet drivers 1 and 2, because it allows tasks to branch from a stale base and leaves the canonical checkout open to edits.

### B. Operator fast-forwards the base

Operator would run `git merge --ff-only origin/<base>` itself, which requires a new `git merge` allow rule on Operator. This is rejected. It broadens Operator's permissions, and `git pull` stays denied for Operator because it can merge or rebase. Operator's permission frontmatter does not change under this ADR.

### C. External fast-forwards during bootstrap, enforced by role contracts and docs (chosen)

External performs `git fetch` and `git merge --ff-only origin/<base>` in the canonical checkout only during task bootstrap, when Lead relays the step after Operator's read-only inspection. The `git merge` command stays ASK for External and gets no allow rule. Operator's read-only inspection is unchanged, and its `git fetch` exception is retained but optional; not part of bootstrap; the bootstrap fetch is External's. The rule is stated in the role contracts and in the workflow documentation. This meets drivers 1 to 5 within the current permission model, and it can be reversed by reverting the text.

### D. Enforce with a harness-installed local Git hook (deferred)

A hook could refuse writes in the canonical checkout. This is deferred to a follow-up issue; no follow-up issue for the hook exists yet. The reasons are that shell patterns cannot identify a worktree, that the hook writes local Git configuration and would need consent, and that install, update, and uninstall handling would be needed. Until that issue is decided, the rule depends on role compliance, and the documentation says so.

### E. An opt-out setting

A project-level flag could disable the rule. This is rejected. The rule applies only where the project uses task worktrees, which is a condition the project already states. A separate flag would add a setting without adding protection.

## Decision

1. **Update path.** External performs the fast-forward update of the base branch in the canonical checkout (`git fetch`, then `git merge --ff-only origin/<base>`), only during task bootstrap relayed by Lead and only when the local base is not ahead of or diverged from `origin/<base>`. Operator's `git fetch` exception is retained but optional; not part of bootstrap; the bootstrap fetch is External's. `git pull` stays denied for Operator, and External never pulls, forces, resets, rebases, or switches branches in the canonical checkout.
2. **Enforcement.** Role contracts and documentation only. No Git hook is installed, no permission rule is added or changed, and the hook is deferred as Option D describes.
3. **No opt-out.** The rule applies only when the project uses task worktrees (a `worktreeDirectory` is configured). A single-checkout project with no `worktreeDirectory` is not affected.
4. **Scope.** The application repository's canonical checkout only. A consumer harness checkout pinned to a release tag (see [releasing.md](../releasing.md)) is out of scope and keeps following `docs/releasing.md`.

The rule, with the same wording in every contract and document:

- The canonical checkout only receives updates from the remote. Allowed: read-only inspection, and a fast-forward-only update of the base branch. Not allowed: edits, commits, merges, rebases, or switching branches. That work goes in a task worktree.
- `<base>` is the project's configured base branch (`baseBranch` in project context). If it is missing or ambiguous, Operator asks Lead.
- "Dirty" means any staged, unstaged, or untracked change (anything `git status` reports). "Mid-operation" means a merge, rebase, cherry-pick, revert, or similar operation in progress.
- Bootstrap order:
  1. Operator inspects the canonical checkout read-only.
  2. If it is dirty, mid-operation, not on the base branch, or detached, Operator reports the observed state and waits for human confirmation. It never repairs the checkout automatically.
  3. Otherwise Lead relays the step to External with `<base>` and the canonical checkout path. External runs `git fetch`, then checks read-only (for example, `git rev-list --left-right --count <base>...origin/<base>`) whether local `<base>` is ahead of or diverged from `origin/<base>`. If it is, External reports and waits for the human, with no repair. Otherwise External runs `git merge --ff-only origin/<base>`. If the fast-forward is not possible, External reports and waits. It never repairs.
  4. Operator creates the task worktree from the updated base.

This replaces the earlier allowances "untouched canonical changes do not block bootstrap" and "if the fetch fails, report it and branch from the local base". Other existing worktrees still do not block bootstrap.

## Consequences

**Positive:** Tasks start from the current remote base. The canonical checkout stays free of agent-made edits and commits. The rule is stated in every role that touches Git, and no permission changes.

**Negative:** The rule depends on role compliance, because no hook enforces it. A dirty or mid-operation canonical checkout now stops bootstrap until a human confirms, which is more friction. Each External fast-forward is an ASK prompt, since no allow rule is added.

**Neutral:** Single-checkout projects see no change. Installed hosts receive the new role text on the next install or update. The permission frontmatter, receipts, and installed rules do not change.

## Adoption

Accepting this ADR does not change tooling, roles, permissions, or defaults. It confers no further authority. The contract and documentation changes ship with this ADR as one text change, under the human plan approval that covers them: the Operator, External, and Lead contracts, `commands/start-issue.md` and its OpenCode output, the workflow documentation, the glossary entries for canonical checkout, base branch, dirty, and mid-operation, the CHANGELOG, and the regression tests. The permission frontmatter of every role stays as it is.

Rollback is a revert of that text change followed by a harness update, which recompiles the installed role text. No receipt or installed configuration needs migration.

## Reconsideration

- A harness-installed Git hook (the deferred follow-up) is approved, or a host gains a worktree-bound permission primitive. Either would supersede Decision 2.
- Recorded outcomes show an agent changing the canonical checkout outside the rule, which the documentation could not prevent.
- Pilot use shows that the bootstrap stop on a dirty canonical checkout blocks routine work too often, which would call for a superseding ADR rather than an in-place edit.

## References

- Issue #172, "Keep the canonical checkout read-only except for remote updates".
- [worktree-permission-proposal.md](../worktree-permission-proposal.md): why shell patterns cannot bind a grant to a worktree.
- [releasing.md](../releasing.md): consumer harness checkouts pinned to a release tag, which are out of scope.
- [Glossary: canonical checkout](../glossary.md#hosts-installation-and-permissions).
- [agents/operator.md](../../agents/operator.md), [agents/external.md](../../agents/external.md), [agents/lead.md](../../agents/lead.md).
