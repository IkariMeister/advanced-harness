---
description: Review a teammate's pull request
---
Review pull request: $ARGUMENTS

Treat arguments as context, not approval. Confirm repository and PR identity; ask if ambiguous. External reads PR and linked Jira/parent context when available. Reviewer examines the diff and existing PR checks first. Propose further local checks to the human; do not automatically run isolated checks. Lead presents change summary and concrete proposed feedback before posting. Ask the human to choose exactly one disposition: Approve, Just Comment, or Request changes; suggest Request changes only for critical issues requiring a fix. Post only after explicit approval of concrete feedback and disposition. External posts approved feedback inline on relevant code lines. No source edits occur automatically; fixes require a separate approved implementation workflow.
