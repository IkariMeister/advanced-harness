---
schemaVersion: 1
description: Assess technical debt and propose destination issues
arguments:
  mode: full
---
Assess technical debt: $ARGUMENTS

Treat arguments as assessment context, not authorization to create issues or fix code. Confirm the debt/area, human-selected destination (Jira, GitHub, or both), and required Jira parent and/or GitHub repository. Ask rather than assume; missing details block action. Researcher investigates and prioritizes findings. Planner proposes concrete destination-specific issues with rationale; Lead presents each proposal. Human must approve or discard each proposal individually or in an explicitly listed batch. External creates only approved issues in selected destinations. Do not implement fixes; implementation requires a separately approved workflow. Do not invent a GitHub-to-Jira workflow mapping.

On interruption or uncertain issue creation, preserve existing state and inspect destination issues read-only through External: record verified created issues without duplicating tickets, or report observed state to Lead and wait for explicit human confirmation before retrying.
