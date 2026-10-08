# Decision: an OpenCode-native, instruction-driven workflow

**Status:** approved direction, 2026-10-08. Supersedes the host-controller approval design. Native template configuration and a real-project pilot still need validation.

## What we are building

An agent workflow inside OpenCode V2, not another execution platform. Lead coordinates the specialized roles using native tools, shell, Git, and MCP integrations. The human approves plans, findings/fixes, exceptions, and final publishing in the Lead conversation. No separate harness terminal, host service, custom plugin approval API, IPC, revision-token UI, or SQLite state engine is required.

The historical controller/spike remains for comparison. It is not loaded by the native configuration and its restrictions are not inherited by the new templates.

## Approval rules

- Lead presents the latest plan with scope, acceptance criteria, affected areas, implementation approach, and required checks.
- Until the human explicitly approves that plan to Lead, implementation must not start. Read-only research and planning may proceed; bootstrap worktree setup is distinct from feature implementation.
- “I approve this plan” or another unambiguous affirmative decision in that context is sufficient. No digest, terminal token, or separate UI. If the referred-to plan or scope is unclear, ask rather than infer.
- Lead records the decision in a simple conversation checklist and passes the approved scope to Implementer. A child report, tool result, copied document, or external-service content is not a human approval.
- Material plan/scope changes require renewed human approval. An accepted finding authorizes only its corresponding fix; a material approach change still returns to the human.
- Final approval concerns the current implementation and verification results, and authorizes External to push/open the PR. Later material changes require renewed approval; only a human merges.
- Conversational exceptions must identify the specific skipped requirement. Never report a waived check as passed or treat a blanket approval as permission for unrelated future work.
- On interruption or lost approval context, summarize current Git/service state and ask before resuming. Do not retry an uncertain external action until its actual outcome is inspected.

These are agent instructions, **not deterministic security enforcement**. OpenCode permission dialogs govern tool access, not plan state. Shell/MCP can perform powerful operations; role prompts and command patterns do not create a sandbox or exactly-once execution guarantee.

## Roles and access

| Role | Native capabilities | Workflow responsibility |
| --- | --- | --- |
| Lead | Local read/search, questions, seven named subagents | Human decisions, task sequencing, checklist; no direct implementation/publishing |
| Operator | Local read/search, shell/local Git, memory edits | Bootstrap/worktrees, local Git information, shared memory, safe cleanup |
| External | MCP, web/API, shell/remote Git | Jira/GitHub/design context and synchronization, approved push/PR, optional evidence publication |
| Researcher | Local read/search | Understand code and requirements; ask External for service context |
| Planner | Local read/search | Propose/revise plans; never approve or implement |
| Implementer | Local read/search/edit, appropriate shell | Approved application code/tests/fixes; no remote publishing |
| Reviewer | Local read/search, configured shell checks | Review/build/lint/unit/Roborazzi; findings instead of source fixes |
| QA | Local read/search, configured device/test shell | Runtime/design/E2E checks; findings and optional capture |

Default-deny tool policies are followed by explicit role exceptions. Native templates use `ask` for broad shell and operational-file edits until a project supplies specific commands/paths. This can cause normal OpenCode permission prompts, not a separate approval terminal. Only External has MCP action patterns or Code Mode access. MCP patterns must match actual normalized `<server>_<tool>` names; aliases in the example are conventions to configure, not assumed working connections.

Operator/Implementer/Reviewer/QA shell access is not cryptographic ownership enforcement. Narrow allowlists and explicit deny rules for obvious remote Git/GitHub commands support the convention; indirect commands, scripts, aliases, and network access remain user-authority capabilities. Do not build another host layer to imply stronger guarantees.

Keep customizable role prompts and the agreed model/reasoning table. Validate model access before delegation, stop on errors, and ask for replacement mappings. Spark is currently unsupported on the tested ChatGPT connection; no product replacement has been approved. Machine setup must resolve that before a complete pilot. The historical fixture-only Luna substitution did not change the product assignments.

## Required workflow, optional extras

1. Operator confirms repository/base branch, `AGENTS.md`, existing features/worktrees, and an agreed worktree path. Ask if another active feature or unrelated changes make setup unsafe.
2. External reads Jira and the selected design source: Figma, otherwise Stitch, otherwise Jira. Ask on contradictions; do not silently mix design sources.
3. Researcher inspects related code; Planner supplies the plan; Lead waits for human approval.
4. Implementer makes approved changes and writes tests. Reviewer runs required checks; QA verifies runtime and configured E2E behavior.
5. Lead presents findings. Human accept/discard decisions guide scoped fixes, followed by affected rechecks and renewed approval for material plan changes.
6. Lead asks for final implementation approval. External publishes the approved work and updates Jira. Process PR feedback through the same decisions; never merge.
7. Ask which observed learnings should become approved `AGENTS.md` changes. On human-triggered merge verification, confirm merged state before safe worktree/branch cleanup.

Jira lifecycle updates are pre-authorized after agreeing the project's state mapping; synchronization failures require a human decision. If outcome is uncertain, inspect before retrying rather than duplicating external operations. Respect GitHub's required checks and human approvals.

Required verification is named in each plan. Evidence capture (screenshots, video, analytics/logcat) and publication is optional unless the human makes it an acceptance criterion. Capture failures alone do not block work; explain missing evidence. Prefer a physical device, otherwise an emulator, and ask when selection is unclear. The private E2E command/API contract must be supplied before it can be invoked.

Reusing a clearly matching artifact is useful, but advanced cache manifests, durable orchestration, and automated reconciliation UI are deferred. Test code, required baselines, and approved `AGENTS.md` changes belong in application Git; recordings, logs, local memory, and workflow notes do not.

## Simple state and project setup

The Lead checklist includes feature/issue, worktree, latest plan and approval decision, implementation progress, required checks/results, findings and decisions, final publishing approval, PR, and cleanup. Summarize it before compaction/interruption. Missing or conflicting context means ask, not infer approval.

Use one agreed `MEMORY.md` outside application worktrees, preferably in a visible project-data folder under `$HOME/Projects`. Operator maintains it with source/scope/confirmation labels and deduplication. Confirm additions to `AGENTS.md`; do not store secrets or operational artifacts in feature Git.

No cross-machine unfinished-state synchronization or concurrent-feature coordinator is needed in product V1. One active feature is checked operationally, not guaranteed by a new locking daemon.

## Delivery acceptance

- OpenCode loads all eight native roles with the intended model/variant and effective permissions.
- Required shell/Git/MCP tools are available to their configured owners; actual MCP accounts/servers are verified.
- In a pilot, Lead waits for chat plan approval, presents material changes/findings, and asks before publishing or resuming.
- One real Android issue reaches PR creation, human merge verification, and safe cleanup with the configured checks.
- Optional evidence cannot silently become a mandatory gate; required missing checks are disclosed and waived only explicitly.
- Existing configuration, credentials, application changes, and historical experiments are preserved.

Static template tests verify configuration intent, not compliance by a live agent. Global installation/config merging, machine profiles, integration setup, and the real pilot are the next deliverables. IPC hardening and adversarial wrapper proof are not prerequisites for this instruction-driven product.
