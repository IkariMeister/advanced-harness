# Worktree-scoped permission proposal (unpublished)

**Status:** design proposal only, prepared 2026-10-12 under the approved BH-009
documentation scope. This is not an implementation, upstream submission, or
guarantee of a security boundary. No upstream issue has been filed.

## Problem and source review

The requested workflow reduces repeated prompts for Git, GitHub CLI, and file edits
inside the **current human-approved worktree only**. Existing OpenCode permission
patterns can authorize tools/actions but do not represent conversational approval of
a plan. Permission grants must never be treated as plan approval.

External's read-only review of official OpenCode `v2.0.26` sources (tag commit
`9b4ec57`, Desktop package 2.0.26) found:

- The permission schema describes `action`, `resource`, and `effect` (`allow`,
  `deny`, `ask`). Core matching is action/resource based, with the last matching
  rule winning; agent, session, and saved allows are considered. Saved rules are
  keyed by project ID, and the project source says “Clones share a project ID.”
- Shell handling resolves a working directory but sends parsed command resources,
  not the cwd, to permission checking. Suggested command patterns include `git`
  with limited arity. This does not bind a grant to the actual worktree path.
- File-access checks use location/project directory concepts; saved
  `external_directory` rules may be rooted at Git root. Edit tool path resources
  are not proof of isolation.

Relevant official source links:
[permission schema](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/schema/src/permission.ts),
[permission matching](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/permission.ts),
[saved permissions](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/permission/saved.ts),
[project identity](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/project.ts),
[shell tool](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool/plugin/shell.ts),
[shell parsing](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/permission/shell-parse.ts).

Issue context, as observed during the same 2026-10-12 read-only review (statuses
may change): [#53118 OPEN](https://github.com/anomalyco/opencode/issues/53118)
requests resolved cwd metadata in permission events, not enforcement;
[#46372 CLOSED, NOT PLANNED](https://github.com/anomalyco/opencode/issues/46372)
reports worktree/session `external_directory` leakage;
[#52083 OPEN](https://github.com/anomalyco/opencode/issues/52083) reports compound-command and
redirection resource gaps on v2.0.18, not reproduced or verified on v2.0.26. A
bounded search found no exact strict-worktree shell proposal; this was not
exhaustive. Installed CLI reports version 2.0.26, but exact binary provenance was
not independently verified. These are source/issues observations, not live-runtime
tests or claims that every report applies to v2.0.26.

## Proposed capability and boundaries

Define an explicitly named, revocable grant bound to one current approved worktree
identity, and only to the particular operation classes the human selects. Candidate
classes are read/edit of paths beneath that worktree and explicitly selected local
Git / GitHub CLI operations. The proposal does **not** choose a permission syntax or
assume OpenCode supports such a grant today.

The authorization target is the current approved worktree—not the repository's
other worktrees, canonical checkout, parent directory, siblings, or every clone
sharing a project ID. Worktree status does not encode plan approval; Lead must still
obtain and track explicit conversational approval.

An enforceable design would need to bind every operation to canonical identity and
the effective target at execution time, including Windows path case/normalization,
junctions, symlinks, UNC paths, moved worktrees, and deleted/recreated paths. It
must define behavior for explicit cwd versus target paths, nested paths, escapes,
and identity changes. A cwd check alone is only a partial cwd guarantee: scripts,
subprocesses, absolute paths, redirects, Git configuration/hooks, and remote or
shared Git metadata can affect locations beyond cwd. Until an implementation can
constrain those effects, the original strict boundary remains unresolved; any
partial cwd-only guarantee requires an explicit human decision and must not be
advertised as confinement.

Revocation must take effect for subsequent operations, including saved grants,
restarts, delegation, and project-ID-sharing clones. Child agents must not inherit
or widen a grant implicitly. Denies must remain authoritative; ambiguous identity,
unsupported operations, or failed validation should fail closed. Higher-precedence
rules or saved allows must not silently widen scope. Tool grants never authorize
remote publication, merge, cleanup, or actions outside the stated operation scope.

Explicit exclusions: no wrapper/orchestration host, host/machine/global allowance,
approval-token system, approval database, service, sandbox guarantee, changes to
permission configuration, or change to role ownership. Operator retains local Git
and worktree ownership; External retains services/remote Git/`gh`; Implementer
retains approved source/test edits. Ask Lead/human when a capability or ownership
boundary is missing.

## Alternatives and unresolved decisions

1. **Strict operation-bound enforcement:** proceed only if upstream can evaluate
   identity, target paths and effects for each operation. Preferred security goal;
   feasibility and supported integration point are unknown.
2. **Cwd-only scoped convenience:** reduces some prompts but does not provide the
   original strict boundary. Do not adopt without a human decision acknowledging
   the limitation and precise excluded effects.
3. **Continue ASK per operation:** preserves current prompts and makes no new
   boundary claim; least change, but does not meet the convenience goal.

Human/upstream design questions include exact eligible operation set; canonical
identity and alias/recreation semantics; whether Git metadata outside the worktree
can be safely covered; grant creation/expiry/revocation UX; precedence with deny,
session, saved, and inherited permissions; delegated child semantics; and behavior
when the host cannot prove a path/effect. No answer is assumed here.

## Future acceptance/test matrix (not run)

- Exact approved cwd: run `git --no-optional-locks status --short --branch`; verify
  the expected decision and no broader remembered grant.
- Alternate worktree, canonical checkout, sibling, and unrelated directory: same
  operation must not inherit authorization.
- `git -C <other-path>` and compound commands: check actual target/effects, not only
  initial cwd or parsed command name.
- File read/edit targets inside, outside, through symlink/junction, UNC, and after
  move/recreate: deny or ask when identity cannot be proven.
- Saved allow, restart, project-ID-sharing clone, delegated child, explicit deny,
  rule ordering, and revocation: no stale or widened scope.
- Scripts, redirections, hooks, subprocesses, and shared Git metadata: verify the
  claimed guarantee or explicitly document unsupported effects; do not infer safety
  from a passing cwd test.

These tests require upstream-supported harnessing and are not permission to run
commands, configure grants, or perform runtime experiments in this proposal task.

## Unpublished feature-request draft and process

**Title:** Define revocable permissions bound to one approved OpenCode worktree

**Request:** OpenCode permissions currently appear to match action/resource rules,
while shell permission resources are parsed command patterns and saved permissions
may be associated with a project identity shared by clones. Could OpenCode support
an explicit, revocable capability scoped to one canonical worktree identity and
checked against the effective cwd, every explicit target, and operation effects?
Please clarify deny/precedence behavior, saved grants and revocation, restart and
delegation semantics, and safe handling of symlinks, junctions, UNC paths, moved or
recreated worktrees, compound commands, scripts, and Git metadata outside the
worktree. A cwd-only check would be useful as a distinct weaker option but should
not be described as filesystem confinement. This request concerns tool permissions
only; conversational human approval remains separate.

This draft is intentionally unpublished. OpenCode's v2.0.26 CONTRIBUTING guidance
asks for a feature request and design approval before implementation PRs, recommends
the feature template, and cautions that long AI-generated descriptions may be
ignored. If the human approves a concise submission, External should use the current
official feature template and recheck current guidance/status first. No publication
or implementation is authorized by this document.
