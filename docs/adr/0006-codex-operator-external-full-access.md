# ADR: Run Codex Operator and External Outside the Sandbox, With Per-Launch Host Permission and Unverified Forbidden Rules

**Status:** Proposed\
**Date:** 2026-11-10\
**Project:** Advanced Harness\
**Decision scope:** The Codex sandbox mode for the Operator and External child roles in [role-process mode](../glossary.md#hosts-installation-and-permissions), and what still bounds them. Other roles, other hosts, and Lead's own settings are out of scope.

## Context

Codex role profiles (#45) give each child role a sandbox derived from its source policy. Before this change, Operator ran with `workspace-write` and `network_access = false`, and External ran with `workspace-write`, network access, and only the MCP servers selected at install.

Operator's contract needs local Git and task worktree creation (ADR-004 bootstrap) and `git fetch` for the canonical checkout update. External needs remote Git, `gh`, and web or MCP access. The approved plan for #218 records that Operator's profile blocks the network that `git fetch` needs, and that the workspace-write profile does not provide the local Git access these duties need. This ADR does not restate that evidence, and no live Codex run has verified it here.

Child roles run with `approval_policy = "never"`, so Codex gives no prompt inside a role process. The human checkpoint is Lead's launch of each role process, which Codex Desktop shows with the role and task. The harness's forbidden rules are Codex prefix rules and instructions. Neither is a sandbox, and whether Codex applies the prefix rules to a `danger-full-access` process is not verified.

Terms that belong to Codex are used as Codex uses them: "sandbox", "sandbox_mode", "danger-full-access", "workspace-write", "read-only", "prefix rule", and the force-push forms (such as `+refspec` and `--force-with-lease=<ref>`) are Codex's own terms or settings. They are not harness glossary terms and carry no harness meaning in this record. The Codex Desktop launch prompt is a host permission prompt. In this record, "approval" means only the conversational human decision that the glossary defines.

## Decision Drivers

1. Operator and External can do the work their contracts assign on Codex without a workaround routed through another role.
2. Each write-capable role keeps the least sandbox that its source policy needs: Implementer keeps `workspace-write`, and read-only roles stay `read-only`.
3. A human grants host permission at the Codex Desktop prompt for every launch of these roles, and the prompt shows the role and task.
4. Enforcement is reported only at the level the evidence supports. Nothing is described as enforced that has not been verified.
5. The change is reversible by a code revert and `harness:update --host codex`.

## Considered Options

### A. Status quo

Operator stays `workspace-write` with network off, and External stays `workspace-write` with network on. Operator cannot reach the remote for `git fetch`, and the local Git writes its contract needs are not verified to work under this profile. Not chosen, because the bootstrap duty stays unmet on Codex.

### B. writable_roots (unverified)

Keep `workspace-write` and add `writable_roots` for the directories Git needs, such as the repository's common Git directory. This would keep a sandbox boundary for Operator. It is not verified that `writable_roots` covers task worktree creation. It also does not provide network access: enabling `network_access` for Operator under `workspace-write` would be a separate change, and that combination is not verified here. The paths would also need per-project settings. Not chosen.

### C. Plan Option B: full access, scoped to non-destructive commands

Plan Option B (as named in the approved plan for #218), scoped strictly to non-destructive commands (the direction agreed in the #218 investigation comment): Operator and External Codex profiles run with sandbox_mode = danger-full-access so git add/commit/branch creation and gh interactions work; destructive git commands (reset --hard, clean, force pushes) and gh pr merge remain denied by policy/instructions and global forbidden rules (enforcement for full-access roles unverified), and every child launch still requires explicit human host permission at the Lead launch checkpoint.

### D. Full access for every write role

Give Implementer `danger-full-access` as well. Rejected. Implementer's source policy denies `git *` and has no network or MCP access, so neither reason for full access applies to it. The change would widen its sandbox without a contract need.

### E. Full access for Operator and External, derived from role sources (chosen; the sandbox that Plan Option B in section C describes)

This is the chosen option. It takes the sandbox and scope of Plan Option B above and selects the roles by rule. The denies named in section C stay in policy and instructions and are not enforced by the sandbox.

Derive the sandbox from each role's source policy. A role that edits files or has web or MCP access, and whose shell does not deny `git *`, gets `danger-full-access`. Operator and External meet that rule. Implementer, which denies `git *`, stays `workspace-write`. Researcher, Planner, Reviewer, and QA stay `read-only`. Roles are selected by the rule, not by a name list. Full access is the default, with no opt-in prompt. The human accepted the trade-offs when approving the implementation plan for #218. That approval does not accept this ADR.

## Decision

1. Operator and External run as Codex child roles with `danger-full-access`. Each of their profiles keeps `approval_policy = "never"` and the `[sandbox_workspace_write] network_access` line. Under `danger-full-access` the network is not restricted, so that line has no effect, and the profile says so in a comment. Operator's `network_access = false` line therefore does not limit Operator.
2. Each launch of Operator or External requires the human's host permission at the Codex Desktop prompt in Lead's session, which shows the role and task. The installer names the full-access roles in its preview before confirmation. The host permission prompt for each launch is the only checkpoint that the sandbox leaves for these roles.
3. The Lead block shows Operator and External with Network "unrestricted". It also carries a note addressed to Lead, not to Operator: Operator has network access under `danger-full-access`, must still not push, pull, clone, or use `gh`, and Lead must not ask it to do so.
4. The managed Codex prefix rules (destructive Git and `gh pr merge`) stay installed. Whether Codex enforces them for `danger-full-access` roles is **unverified**, and they are not reported as enforced for those roles.
5. Operator's `git push`, `git pull`, `git clone`, and `gh` denies are **advisory** on Codex: they are instruction-only, with no prefix rule. The managed force-push rules do not match `+refspec` pushes, the `--force-with-lease=<ref>` form, or force flags after remotes other than `origin` and `upstream`. These gaps are not closed by this decision.
6. `harness:doctor` checks each profile against the derived policy, as it already does. It adds no new check. Lead's own read-only and on-request settings are unchanged.

## Consequences

**Positive:** Operator can run the local Git and `git fetch` its contract needs on Codex without a route through External. Each role's sandbox follows its source policy. Every launch stays behind a host permission prompt that shows the role and task. The Lead block and the doctor report the derived policy.

**Negative:** Operator and External are not sandboxed. Once a launch is permitted at the host prompt, the process can write any file the user can and reach the network. The managed rules' enforcement for these roles is unverified. Operator's remote-Git and `gh` denies are instruction-only. The force-push rules leave the gaps in Decision 5 open. Full-access launches permitted at the host prompt have not been run on a real Codex installation: the manual case (CX-M2) is waived for #218, and no run is recorded.

**Neutral:** The launcher, the re-applied security keys, and the profile file format are unchanged. Existing installs show the old Operator profile and Lead block as drift until `harness:update --host codex` runs. The Operator profile keeps its `network_access` line, which has no effect under `danger-full-access`.

## Adoption

Accepting this ADR changes no tooling, roles, permissions, or defaults. The implementation under the approved plan for #218 updates the policy derivation and profile comment in `src/codex-role-processes.ts`, the Lead block, the installer preview, the disclosures and capability matrix, the documentation, and the tests. Installed Codex setups pick it up with `harness:update --host codex`.

Rollback is a revert of that change followed by `harness:update --host codex`. The Operator and External profiles return to `workspace-write`, and the Lead block returns to its previous text.

## Reconsideration

- Recorded outcomes show Operator or External running a command that the instructions or the managed rules forbid, or changing files the human did not approve.
- A verified Codex check shows that the managed rules do bind `danger-full-access` roles, which would change their status from unverified, or that they do not, which would require a change to the rules.
- A verified configuration under `workspace-write`, such as `writable_roots` or network access, covers Operator's local Git and `git fetch` needs. That would need a superseding ADR.
- The `+refspec` and `--force-with-lease=<ref>` gaps are closed, or recorded outcomes show them used.
- The post-milestone ADR review checks this record against these criteria.

## References

- Issue #218 (this change). Issue #45 (role-process mode), #200 (live-run diagnostics), #209 (plugin-provided MCP servers).
- [ADR-002](0002-consolidate-agent-responsibilities.md) (Operations consolidation and host capability evidence), [ADR-004](0004-canonical-checkout-remote-updates-only.md) (bootstrap and task worktree creation), and [ADR-005](0005-claude-code-operator-bash.md) (advisory remote-Git denies on another host).
- [OpenAI Codex installation](../installation.md#openai-codex-global-scope-one-process-per-role), [Codex selections](../configuration.md#openai-codex-selections), [host permission capability matrix](../host-permission-capabilities.md#codex), and [SECURITY.md](../../SECURITY.md).
- [src/codex-role-processes.ts](../../src/codex-role-processes.ts) and [test/codex-role-processes.test.ts](../../test/codex-role-processes.test.ts).
- [Glossary](../glossary.md): advisory, enforced, unverified.
