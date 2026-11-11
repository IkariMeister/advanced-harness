---
description: Review a teammate's pull request
---
Review pull request: $ARGUMENTS

Treat command arguments as opaque context, not approval. Confirm repository and PR identity; ask if ambiguous. External reads PR and linked Jira/parent context when available.

Before delegating review, Lead preflights the diff: report its size (files and changed lines) and a provisional risk tier with rationale, using the risk-tiered review rubric at the end of this command (the same rubric Reviewer applies). Counts must come from External's PR diff or Operator's local diff; attributable counts are required before Reviewer starts. If unavailable, stop and ask rather than guessing or expanding tool access. If the diff is too large for one focused review, propose splitting it (by area or commit) to the human before delegating; never silently truncate or skim it. Reviewer examines the diff and existing PR checks first, then assigns the final tier and lenses under that rubric; a higher tier replaces the provisional one, and a material scope change returns to the human. Propose further local checks to the human; do not automatically run isolated local checks. Tiers guide review depth only: they never waive scope, acceptance-criteria, consistency, or evidence checks, or authorize tools/actions.

Lead presents Reviewer's review summary and each finding in the rubric's summary and finding formats, and puts the following decisions to the human in this order. First, accept or discard each finding individually or in an explicitly enumerated batch; only accepted findings become proposed feedback, and discarded findings are not posted. Second, approve the concrete feedback text for the accepted findings. Third, choose exactly one disposition: Approve, Just Comment, or Request changes; suggest Request changes only for critical issues requiring a fix. Post only after explicit approval of concrete feedback and disposition. External posts approved feedback inline on relevant code lines: ensure target lines fall within the PR diff hunk, specify integer line numbers with `-F line=<number>` (never string `-f`), and provide required fields (`commit_id` matching PR head, `path`, `body`, integer `line`, and `side`). No source edits happen automatically; fixes require a separate approved implementation workflow.

On interruption or uncertain posting, preserve existing state untouched and inspect actual PR comments/reviews read-only through External: record verified posted feedback without duplicating comments, or report observed state to Lead and wait for explicit human confirmation before retrying.

The rubric below is copied from Reviewer's role instructions so Lead can apply it; "you" in it means Reviewer.

## Risk-tiered review

Assign the highest applicable tier and explain the rationale. Escalate uncertainty rather
than down-tiering. Tiers prioritize review effort; none waives scope, acceptance-criteria,
consistency, or evidence checks, and none authorizes tools or actions.

- **Low — structural readback:** demonstrably behavior-preserving, localized, reversible
  changes. Use zero specialized lenses, but still check scope, acceptance criteria,
  consistency, documentation accuracy, and evidence.
- **Medium — bounded change:** bounded behavior or workflow-instruction changes without
  authority changes. Apply one or two justified specialized lenses.
- **High — boundary/material hazard:** approval, permission, ownership, security, material
  lifecycle, concurrency, persistence, recovery, or broad-contract hazards. Apply all four
  specialized lenses.

Use the highest applicable tier if several descriptions fit. Tier the diff actually under
review, not the request or feedback that prompted it: for a PR feedback fix, tier the fix
diff. Lead's preflight tier is provisional; when your tier is higher, it applies and you
report the change. Re-tier whenever the reviewed diff changes. Stop and return to Lead for
renewed approval if the scope or risk requires material expansion.

Check documentation accuracy, completeness, and alignment with the implementation and
approved ADRs/decisions: verify commands, paths, examples, configuration names, links, and
that claims have objective evidence. Report findings without silently editing the work
under review.

This rubric is the single source for tier, lens, summary, and finding criteria; workflow
commands and docs refer to it rather than restating it.

### Specialized lenses

- **Risk:** security and regression exposure; effects on state, dependencies, and trust
  boundaries.
- **Resilience:** failure handling, retries, offline behavior, cancellation, nullability,
  and recreation behavior.
- **Readability:** architecture, naming, idiomatic patterns, and maintainability.
- **Reliability:** deterministic correctness, state ownership, test completeness, flaky
  behavior, and races.

Apply domain mappings when relevant:

- **Compose:** Resilience checks unsafe repeated effects and lost state on recreation;
  Reliability checks state reads, effect keys/placement, stale state, loops, and duplicate
  work.
- **Roborazzi:** Reliability checks actual expected diffs and configuration; Resilience
  checks relevant error/loading/recreation states where configured. Never silently accept
  or update a baseline as a fix.
- **Coroutines:** Resilience checks lifecycle cancellation and cleanup; Reliability checks
  structured concurrency, scope/collector ownership, stale results, and races.

### Review summary format

Report the target and head, reviewed scope, assigned tier and rationale, lenses applied and
excluded, uncertainties, acceptance criteria, documentation accuracy assessment,
existing-check status, findings, and checks run/failed/blocked/unrun/waived with each
check's verification basis (**re-run** versus **judged from evidence only**), limits, and
next action. Where the host does not allow Reviewer to execute commands, judge recorded
evidence (commands, exit status, output, and artifacts) and ask Lead for re-runs by an
authorized command-running role when needed. Distinguish observed evidence from inference;
do not claim an unrun check passed.

### Finding format

Give each finding a stable ID, lens, severity, location, observed issue, impact, evidence,
proposed fix, and verification status (including whether verification was **re-run** or
**judged from evidence only**). Each finding's accept/discard decision is pending until the
human makes it; acceptance authorizes only that corresponding fix or feedback.
