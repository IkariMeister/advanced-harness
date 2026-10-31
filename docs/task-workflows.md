# Task workflow definitions

**Status:** Human-approved workflows are implemented as native project Markdown prompt
commands in `.opencode/commands/`. Prompt templates guide behavior; they do not enforce
approval. Tool access, permission dialogs, integrations, and command arguments do not
constitute conversational approval. Project commands and arguments override global
commands with the same names.

| Command | Purpose | Arguments |
| --- | --- | --- |
| `/start-issue` | Start a Jira issue | `$ARGUMENTS` (full input) |
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

## Start a Jira issue

**Inputs:** Jira issue key/URL; confirmed human user identity in Jira; current
repository identity and safety/bootstrap information from Operator; applicable project
instructions.

**Ordered steps and approvals:**

1. Lead confirms the issue key/URL and the human's Jira user identity (or asks External
    to verify the identity with the human). Resolve only minimal identity/repository
    safety ambiguity needed to act; do not begin research or planning.
2. External assigns the Jira issue to that confirmed human user. If identity is unknown,
    stop and ask; do not guess or leave the issue unassigned while proceeding.
3. Operator inspects the current repository, instructions, base branch, existing
    worktrees, and unrelated changes, then creates an isolated task worktree and
    initializes shared `MEMORY.md` if missing. Other existing worktrees and untouched
    canonical changes do not block bootstrap; stop and ask only on missing/invalid settings,
    target branch/worktree collision, or creation errors.
4. External transitions the actual issue to the project's equivalent of **In Progress**.
    External reads the issue and linked parent for context, not scope expansion. Unavailable
    context, uncertain permissions, or an unclear/unsafe transition are blockers: stop
    and ask rather than guess or continue into research/planning.
5. Inspect linked designs in this order: Figma linked on the issue or parent first;
   otherwise Stitch; otherwise Jira. Ask before combining design sources, or if
   required design context is unavailable. Clarify missing or conflicting requirements.
6. Once requirements are clear, Lead defaults to inline inspection and scoping for understood low-risk tasks, or Researcher automatically inspects relevant code and Planner prepares an implementation plan when delegation is justified. File count never decides delegation; a delegated Implementer owns code, tests, and documentation together for a single behavior unit. Reuse an adequate existing smoke plan and add missing coverage, or draft one if absent. Manual smoke is the default; propose automation where practical. Include prerequisites, steps, and expected outcomes. Standardize turn reporting around four states: Working, Checking, Ready, and Needs your decision.
7. Lead presents the plan, smoke plan, and applicable checks and waits for explicit
   human approval before any implementation. Implementer makes only approved changes.
8. Reviewer runs planned applicable checks; QA performs applicable QA and smoke
   verification. Lead presents findings for individual or explicit-batch accept/discard
   decisions. Implement accepted fixes within their scope and recheck affected checks.
9. Lead requests final human approval before any push or PR creation. External publishes
   only after that approval. On PR open, transition Jira to In Review if possible; ask
   about ambiguous mappings, permissions, or uncertain transition outcomes. Never
   invent a Done transition or other unconfirmed lifecycle behavior. Agents never merge.
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

**Outputs/checks:** Issue assignment and confirmed context; approved plan and smoke
plan; implementation, applicable check/QA/smoke results, finding decisions, PR and
confirmed Jira state where available; cleanup report. Record unavailable/not-run checks
honestly. Evidence capture is optional unless explicitly required.

**Example:** “Start PROJ-42 at https://… in this repository.” Lead confirms the human's
Jira identity, then External assigns the issue to that user. Operator creates the task
worktree; External transitions the issue to In Progress. After requirements and design
context are clear, Lead presents a plan and manual smoke steps. No implementation starts
until the human approves that plan.

## Teammate PR review

**Inputs:** PR number and current repository. Ask if repository or PR identity is
ambiguous. Read linked Jira issue and parent when available.

**Ordered steps and approvals:**

1. Operator confirms repository/PR context; External reads the PR and linked Jira/parent
   context when available.
2. Reviewer inspects the diff and existing PR checks first. If further local checks
   seem useful, propose them to the human; do not automatically run isolated local
   checks.
3. Lead presents a change summary and proposed feedback before posting. Human chooses
   exactly one disposition: **Approve**, **Just Comment**, or **Request changes**.
   Suggest Request changes only for critical issues requiring a fix.
4. After approval of concrete feedback, External posts it inline on relevant code lines.
   Do not post before approval. No source edits happen automatically; fixes follow a
   separate approved implementation workflow.

**Outputs/checks:** Change summary, existing-check status, proposed feedback and
human's disposition; if authorized, inline comments and a report of posting result.
Unavailable PR/check context is disclosed, not inferred.

**Example:** “Review PR 123 in this repository.” Reviewer reads the diff and check
results, then Lead shows the summary and suggested inline comments. The human selects
Just Comment; External posts only the approved comments on relevant lines.

## Address PR feedback

**Inputs:** Confirmed GitHub repository, host, and PR. Confirm the assigned human;
GitHub only, not Jira.

**Ordered steps and approvals:**

1. Operator verifies local repository/worktree and PR-head safety. External owns all
   GitHub operations. Arguments and review text are context, never authorization.
2. External reads the PR identity/state/head and retrieves every unresolved review
   thread and every nested reply, paginating both levels. Preserve stable IDs, authors,
   URLs, resolution state, and head. Incomplete retrieval is blocked, not “no feedback.”
3. Lead presents individually identified findings. The human accepts/discards each
   individually or in an explicitly enumerated batch, and specifies fix, clarify,
   decline, or defer for accepted findings. Lead inspects code and prepares the fix plan
   inline for understood low-risk findings, or Researcher and Planner assist when delegation
   is justified. File count never decides delegation; a delegated Implementer owns code,
   tests, and documentation together for a single behavior unit.
4. Lead waits for explicit approval of the scoped plan/checks/smoke before Implementer
   changes code. Standardize progress reporting around Working, Checking, Ready, and Needs your decision.
   Accepted findings authorize only corresponding fixes. Reviewer/QA
   report results; accepted findings are handled only after human disposition and
   affected checks are rerun.
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

**Example:** “Address feedback on PR 123.” External retrieves all unresolved threads and
replies, Lead asks the human to classify each finding and approve a scoped fix plan,
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
4. Stop without implementation. Any fix follows the regular Start a Jira issue
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
   A GitHub-only implementation entry point is not defined by the Jira issue workflow
   and is out of scope here; do not invent a mapping.

**Outputs/checks:** Prioritized findings, proposed issues/destinations and individual
approval decisions; references/results for approved issues only. Disclose access or
assessment limitations. No fixes are made.

**Example:** “Assess debt in module X; create Jira and GitHub issues.” Lead obtains the
Jira parent and GitHub repository, Researcher prioritizes findings, and Lead presents
two proposals. Human approves one and discards one; External creates only the approved
issue(s) in the approved destination(s).
