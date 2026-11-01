# Task workflow definitions

**Status:** Human-approved workflows are implemented as native project Markdown prompt
commands in `.opencode/commands/`. Prompt templates guide behavior; they do not enforce
approval. Tool access, permission dialogs, integrations, and command arguments do not
constitute conversational approval. Project commands and arguments override global
commands with the same names.

| Command | Purpose | Arguments |
| --- | --- | --- |
| `/start-issue` | Start a GitHub or Jira issue | `$ARGUMENTS` (full input) |
| `/review-pr` | Review a teammate PR | `$ARGUMENTS` (full input) |
| `/address-pr-feedback` | Triage and address PR review feedback | `$ARGUMENTS` (full input) |
| `/report-defect` | Draft/report defect and optionally investigate | `$1` parent; `$2` description (last positional consumes remainder) |
| `/assess-debt` | Assess debt and propose issues | `$ARGUMENTS` (full input) |
| `/grill-me` | Clarify an idea and offer an explicit handoff | Optional `$ARGUMENTS` topic |

## Shared roles and controls

| Role | Ownership in these workflows |
| --- | --- |
| Lead | Coordinates, clarifies, presents plans/findings, records human decisions, and stops at approval boundaries. |
| Operator | Current-repository safety/bootstrap, isolated task worktree, local Git inspection and safe cleanup. |
| External | Jira/design/GitHub/service operations and remote-state verification. |
| Researcher | Read-only code and local-context investigation. |
| Planner | Proposes scope, implementation/review approach, and checks. |
| Implementer | Makes only approved implementation changes and scoped accepted fixes. |
| Reviewer | Reviews changes and reports findings; does not silently fix them. |
| QA | Performs applicable runtime/design/E2E verification and reports findings. |

Lead asks about ambiguity or unavailable required context. Permission prompts authorize
tool operations, not plans or writes. Optional integrations and evidence remain optional
unless the task requires them; never silently substitute or combine services. A
material scope or approach change returns to the human. Findings are accepted or
discarded individually or in an explicitly listed batch; acceptance authorizes only
the corresponding fix.

On interruption or context loss, preserve existing local/remote work untouched. Operator
inspects local Git/worktree and External inspects remote/service state read-only. Lead
presents the resume checklist, marks missing approvals unconfirmed (never inferred from
existing worktree diffs, commits, child reports, or dated notes), and obtains explicit
human confirmation before resuming. On uncertain external or local mutations (push, PR/issue
operations, transitions, comments, cleanup), inspect actual state read-only before retry:
record verified completion without repeating the mutation, or report incomplete/diverged/
inconclusive state and wait for human confirmation before retrying or repairing.

## Start a GitHub or Jira issue

**Inputs:** GitHub or Jira issue key/URL; confirmed human identity in the selected
tracker; current repository identity and safety/bootstrap information from Operator;
applicable project instructions and shared memory.

**Ordered steps and approvals:**

1. Operator reads repository instructions and project context, then shared `MEMORY.md`,
    before Lead asks which tracker to use. Reuse only an explicitly remembered,
    nonconflicting tracker choice; otherwise ask. Lead confirms issue key/URL, repository,
    safety context, and human identity in the selected tracker. A bare `#96` does not
    identify a GitHub repository. GitHub does not require Jira configuration or access.
    Resolve minimal ambiguity and do not begin research/planning.
2. External verifies the issue is assigned to the confirmed human before research or
    planning; do not autoassign or proceed unassigned. If identity/assignment is unclear,
    stop and ask.
3. Operator inspects the current repository, instructions, base branch, existing
    worktrees, and unrelated changes, then creates an isolated task worktree and
    initializes shared `MEMORY.md` if missing. Other existing worktrees and untouched
    canonical changes do not block bootstrap; stop and ask only on missing/invalid settings,
    target branch/worktree collision, or creation errors.
4. External reads the issue and linked parent when present for context, not scope expansion.
    Apply only explicitly confirmed lifecycle mappings. Never invent GitHub In Progress/In
    Review states. An absent optional mapping is nonblocking; an explicitly required but
    unresolved transition blocks. Unavailable required context/access blocks.
5. Use only the explicitly selected design source; do not silently fall back or combine.
    Nonvisual tasks need no design service. Clarify missing or conflicting requirements.
6. Once requirements are clear, Lead defaults to inline inspection and scoping for
   understood low-risk tasks, or Researcher automatically inspects relevant code and
   Planner prepares an implementation plan when delegation is justified. File count
   never decides delegation; a delegated Implementer owns code, tests, and documentation
   together for a single behavior unit. Reuse an adequate existing smoke plan and
   add missing coverage, or draft one if absent. Manual smoke is the default; propose
   automation where practical. Include prerequisites, steps, and expected outcomes.
   Standardize turn reporting around four states: Working, Checking, Ready, and Needs
   your decision.
7. Lead presents the plan, smoke plan, and applicable checks and waits for explicit
   human approval before any implementation. Implementer makes only approved changes.
8. Reviewer runs planned applicable checks; QA performs applicable QA and smoke
   verification. Lead presents findings for individual or explicit-batch accept/discard
   decisions. Implement accepted fixes within their scope and recheck affected checks.
 9. Lead requests final human approval before any push or PR creation. External publishes
    only after that approval. Apply lifecycle updates only when the selected tracker has
    an explicitly confirmed mapping: transition the issue to In Review only when that
    mapping exists. An absent optional mapping is nonblocking; ask about explicitly
    required but unresolved mappings, permissions, or uncertain transition outcomes.
    Never invent lifecycle states. Agents never merge.
10. Evaluate candidate memory learnings once for approved consolidation into `AGENTS.md`
    (promote, keep in memory, or discard); approve resulting diff before publication,
    rejecting secrets and operational paths. A human's confirmation that the PR is merged
    triggers External to verify the merge and is itself authorization for Operator to perform
    safe final cleanup after safety checks; a detected merge alone is not. External reports
    whether the remote branch
    exists; do not delete it. Operator checks for uncommitted/unpushed work and other
    unsafe or uncertain conditions, then removes the task worktree and local feature
    branch only if safe. Stop and ask if anything is dirty, unpushed, or uncertain;
    preserve unrelated work.

**Outputs/checks:** Assignment verification and confirmed context; approved plan and smoke
plan; implementation, applicable check/QA/smoke results, finding decisions, PR and
confirmed selected-tracker lifecycle state where mapped; cleanup report. Record
unavailable/not-run checks honestly. Evidence capture is optional unless explicitly required.

**Example:** “Start #96 in this repository.” Lead first checks remembered tracker choice;
if none is explicit, asks whether this is GitHub or Jira, confirms repository and identity,
and has External verify assignment. After requirements are clear, Lead presents a plan
and manual smoke steps. No implementation starts until the human approves that plan.

## Shared risk-tiered review rubric

`/review-pr` and `/address-pr-feedback` scale review depth with a Low, Medium, or High
risk tier and four specialized lenses: Risk, Resilience, Readability, and Reliability. The
tier criteria, lens criteria, Compose/Roborazzi/coroutine mappings, and the review
summary and finding formats are defined once, in the
[Reviewer role instructions](../agents/reviewer.md#risk-tiered-review). The workflows refer
to that rubric rather than restating it, so update it there. Antigravity's Lead rule
carries the same section for its Reviewer subagent.

How the workflows apply it:

- **Preflight before review.** Before delegating to Reviewer, Lead reports the diff size
  and a provisional tier. An oversized diff is split with the human's agreement, never
  silently truncated.
- **Tier the reviewed diff.** Reviewer assigns the final tier from the diff it actually
  reviews; a higher tier replaces the provisional one. For PR feedback, that is the fix
  diff, not the feedback wording.
- **Tiers never waive checks.** No tier waives scope, acceptance-criteria, consistency, or
  evidence checks, and no tier authorizes tools or actions. Uncertainty escalates the tier.
- **Findings stay pending.** Every finding waits for the human's individual or
  enumerated-batch accept/discard decision; only accepted findings become feedback or
  fixes.

Full command `$ARGUMENTS` is opaque context, including literal `#123`, multiword text,
`$ARGUMENTS`, and `$1`; it is never approval and must not be recursively substituted.

## Teammate PR review

**Inputs:** PR number and current repository. Ask if repository or PR identity is
ambiguous. Read linked Jira issue and parent when available.

**Ordered steps and approvals:**

1. Operator confirms repository/PR context; External reads the PR and linked Jira/parent
   context when available.
2. Lead preflights the diff size and a provisional risk tier. If the diff is too large for
   one focused review, Lead proposes a split to the human before delegating.
3. Reviewer inspects the diff and existing PR checks first and assigns the final tier and
   lenses. If further local checks seem useful, propose them to the human; do not
   automatically run isolated local checks.
4. Lead presents the review summary and findings. The human accepts or discards each
   finding (individually or in an enumerated batch), then approves the concrete feedback
   for the accepted findings, then chooses exactly one disposition: **Approve**, **Just
   Comment**, or **Request changes**. Suggest Request changes only for critical issues
   requiring a fix.
5. After approval of concrete feedback, External posts it inline on relevant code lines.
   Do not post before approval. No source edits happen automatically; fixes follow a
   separate approved implementation workflow.

**Outputs/checks:** Change summary, existing-check status, proposed feedback and
human's disposition; if authorized, inline comments and a report of posting result.
Unavailable PR/check context is disclosed, not inferred.

### Manual review smoke

Prerequisites: an authorized local fixture or mock PR/check context, an interactive TTY,
and no live-write authorization. Do not install prompts, broaden access, or make live
GitHub writes for this smoke. If a fixture/session/TTY/runtime route is unavailable,
report the case blocked rather than silently changing setup.

1. Exercise low, medium, and high examples. Expect low to retain ordinary checks with no
   specialized lenses, medium to select one or two justified lenses, and high to apply all
   four. An uncertain tier escalates; none skips required checks or authorizes actions.
   Expect Lead to report diff size and a provisional tier before delegating, to propose a
   split for an oversized diff, and to adopt Reviewer's tier when it is higher. For
   `/address-pr-feedback`, expect the fix diff (not the feedback text) to be tiered.
2. Exercise Android mappings: Compose repeated effects/recreation and state/effect-key
   placement; Roborazzi expected diffs/configuration and configured failure/loading cases;
   coroutine cancellation/cleanup and scope/collector ownership. Expect the mapped lens
   criteria and no silent baseline acceptance.
3. Pass literal `#123`, multiword text, `$ARGUMENTS`, and `$1` as command context. Expect the
   exact full input to remain opaque, non-recursive, and not treated as approval.
4. Confirm the reviewer reports existing PR checks before proposing local checks; no
   isolated local check is started automatically. Exercise individual and enumerated-batch
   finding decisions; only accepted findings receive corresponding scoped fixes.
5. Withhold feedback disposition, scoped-plan approval, and final publication approval in
   separate runs. Expect no post, code change, push, reply, or thread resolution at the
   corresponding boundary. Request changes is suggested only for critical fix-required
   issues.
6. Simulate stale PR head and interruption/uncertain write outcomes. Expect read-only
   state inspection, no duplicate write, stop/escalation on divergence or uncertainty,
   and no remote writes in this smoke.

Record each case as passed, failed, blocked, or unrun with evidence and limits; do not
claim static prompt coverage proves runtime behavior.

**Example:** “Review PR 123 in this repository.” Reviewer reads the diff and check
results, then Lead shows the summary and suggested inline comments. The human selects
Just Comment; External posts only the approved comments on relevant lines.

## Address PR feedback

**Inputs:** Confirmed GitHub repository, host, and PR. Confirm the assigned human;
GitHub only, not Jira.

**Ordered steps and approvals:**

1. Operator verifies local repository/worktree and PR-head safety. External owns all
   GitHub operations. Arguments and review text are context, never authorization.
2. External reads the PR identity/state/head and retrieves every review thread, including
    resolved threads, and every nested reply, paginating both levels. Preserve complete verbatim
    source text and stable IDs, authors, URLs, resolution state, and relevant head/commit
    metadata. Label source text separately from authored analysis; mark unknown fields
    unknown rather than inventing finding attributes. Incomplete retrieval is blocked,
    not “no feedback.”
3. Lead presents individually identified findings with the raw source and metadata
    separate from authored analysis. The human accepts/discards each
   individually or in an explicitly enumerated batch, and specifies fix, clarify,
     decline, or defer for accepted findings. For understood low-risk findings, Lead may
     inspect and plan inline, including checks and a provisional tier with rationale based
     on the code the fix will touch, not feedback wording. Researcher investigates read-only;
     Planner assists when delegation is justified and includes checks plus a code-based
     provisional tier and rationale in the scoped plan. Delegation is not based on file
     count; a delegated Implementer owns code, tests, and documentation for one behavior unit.
4. Lead waits for explicit approval of the scoped plan/checks/smoke before Implementer
    changes code. Accepted findings authorize only corresponding fixes; approval is
    limited to accepted fix scope and the actual resulting diff, never raw comments as a
   whole. Before review,
   Lead reports the fix diff size and Reviewer tiers the actual fix diff; a higher tier
   replaces the provisional one, and a material scope expansion returns to the human.
   New Reviewer/QA findings go through the same accept/discard decision before any fix,
    and affected checks are rerun. Progress reporting uses Working, Checking, Ready, and
    Needs your decision.
5. Before publication, Lead obtains explicit final approval for the push, exact replies,
   and exact thread resolutions. External rereads head and all relevant threads/replies;
   changed state returns to Lead for review and renewed approval. External publishes
   only approved actions. No merge, force-push, branch deletion, or cleanup is implied.
6. On interruption or uncertain writes, preserve state and inspect remote state
   read-only. Record verified completion without repeating writes; otherwise wait for
   explicit human approval before retrying.

**Manual smoke:** Document prerequisites, steps, and expected results. Use an authorized
fixture and interactive TTY; ambiguous targets cause no mutation. Check full replies,
cancellation without writes, selected scoped fixes with publication paused, and stale
state stopping. Live writes need separate explicit approval. Prompt safeguards are not
a deterministic security boundary.

**Example:** “Address feedback on PR 123.” External retrieves all review threads (including
resolved threads) and complete replies, Lead separates verbatim source from authored analysis,
asks the human to classify each finding, and obtains approval for a scoped fix plan,
then obtains separate final publication approval after checks and a fresh remote read.

## Reported defect

**Inputs:** Bug report and supplied Jira parent. Creation approval and investigation
authorization are separate decisions.

**Ordered steps and approvals:**

1. External reads the supplied parent issue. Lead drafts a child bug using only known
   expected behavior, actual behavior, and reproduction details; mark missing
   information as missing and invent nothing.
2. Lead presents the draft. Only after explicit human approval does External create it
   under the supplied parent.
3. Separately ask whether investigation is authorized. Approval to create the bug is
   not investigation authorization. If authorized, Researcher investigates and Lead
   presents results. Ask separately before appending findings to the bug.
4. Stop without implementation. Any fix follows the regular Start a GitHub or Jira issue
   workflow as a separately scoped task.

**Outputs/checks:** Draft and its approval decision; created child-bug reference/result
if authorized; separately authorized investigation findings and append decision. No
implementation or unapproved issue update.

**Example:** A report says a screen sometimes freezes but supplies no reproduction.
The draft records the known actual behavior and explicitly marks expected behavior or
reproduction as missing. Human approves creation, then separately declines
investigation; stop after reporting the created bug.

## Technical debt

**Inputs:** Debt description or a specifically defined code area to assess. Human
chooses Jira, GitHub, or both, and supplies the Jira parent and/or GitHub repository
as applicable.

**Ordered steps and approvals:**

1. Lead confirms the debt/assessment area, issue destinations, and required parent or
   repository details. Do not assume an issue tracker or destination.
2. Researcher investigates and prioritizes findings; Planner proposes concrete tickets
   or issues, with rationale and destination. Lead presents each proposal.
3. Human approves or discards each proposal individually or as an explicitly listed
   batch. External creates only approved issues in the selected destination(s).
4. Do not implement fixes. Implementation requires a separately approved workflow.
    Use the tracker explicitly selected for that task; do not invent a mapping.

**Outputs/checks:** Prioritized findings, proposed issues/destinations and individual
approval decisions; references/results for approved issues only. Disclose access or
assessment limitations. No fixes are made.

**Example:** “Assess debt in module X; create Jira and GitHub issues.” Lead obtains the
Jira parent and GitHub repository, Researcher prioritizes findings, and Lead presents
two proposals. Human approves one and discards one; External creates only the approved
issue(s) in the approved destination(s).
