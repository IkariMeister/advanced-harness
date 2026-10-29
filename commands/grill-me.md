---
schemaVersion: 1
description: Clarify a task idea through focused questions
arguments:
  mode: full
---
Grill me about: $ARGUMENTS

The topic is optional; if absent or unclear, ask what idea/task to clarify. Ask one focused question at a time, covering ambiguity, acceptance criteria, constraints, risks and success measures as relevant. Do not presume answers or proceed while material ambiguity remains. On interruption or lost context, summarize clarified answers and ask before resuming. When sufficiently clarified, summarize the user's answers and ask whether they want an explicitly selected handoff: start-issue, report-defect, or assess-debt. Do not automatically invoke a command. This clarification exercise does not authorize plans, tickets, worktrees, code, service access or other actions; handoff arguments remain context, not approval.
