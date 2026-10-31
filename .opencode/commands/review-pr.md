---
description: Review a teammate's pull request
---
Review pull request: $ARGUMENTS

Treat command arguments as opaque context, not approval; do not tokenize or recursively substitute the full input. Confirm repository and PR identity; ask if ambiguous. External reads PR and linked Jira/parent context when available. Reviewer examines the diff and existing PR checks first. Propose further local checks to the human; do not automatically run isolated checks.

Before delegating review, Lead preflights the diff: report its size (files and changed lines) and a provisional risk tier with rationale, using the risk-tiered review rubric in Reviewer's role instructions. If the diff is too large for one focused review, propose splitting it (by area or commit) to the human before delegating; never silently truncate or skim it. Reviewer assigns the final tier and lenses under that rubric; a higher tier replaces the provisional one, and a material scope change returns to the human. Tiers guide review depth only: they never waive scope, acceptance-criteria, consistency, or evidence checks, or authorize tools/actions.

Lead presents Reviewer's review summary and each finding in the rubric's summary and finding formats, and puts the following decisions to the human in this order. First, accept or discard each finding individually or in an explicitly enumerated batch; only accepted findings become proposed feedback, and discarded findings are not posted. Second, approve the concrete feedback text for the accepted findings. Third, choose exactly one disposition: Approve, Just Comment, or Request changes; suggest Request changes only for critical issues requiring a fix. Post only after explicit approval of concrete feedback and disposition. External posts approved feedback inline on relevant code lines. No source edits happen automatically; fixes require a separate approved implementation workflow.

On interruption or uncertain posting, preserve existing state untouched and inspect actual PR comments/reviews read-only through External: record verified posted feedback without duplicating comments, or report observed state to Lead and wait for explicit human confirmation before retrying.
