# Native OpenCode workflow agents

These are the source templates for the approved [conversational workflow](../docs/opencode-native-workflow.md). They use native filesystem/shell/Git/MCP capabilities; they never invoke `harness_*` tools or a separate approval host.

## Versioned role-source format

The eight canonical role files use source schema version 2. Their nested policy is
explicitly OpenCode-bound (`binding.host: opencode`) and declares
`resolution: ordered-last-match`; this records the current native precedence and is
not a universal permission language or a claim that prose enforces a security boundary.
The loader compiles capability/resource/effect records back to the original OpenCode
action/resource/effect rules in their original order. Native action bindings remain
authoritative and are preserved losslessly.

Unversioned legacy role files using `permissions` remain supported as read-only input
for compatibility and are normalized through the same OpenCode compiler. They are not
rewritten automatically. Explicit unsupported schema versions, simultaneous
`permissions` and `policy`, unknown actions, or mismatched native bindings are rejected
before deployment writes. This source migration does not migrate or rewrite installed
OpenCode configuration, receipts, backups, or permission ownership records.

## Configuration intent

- Lead delegates to the seven named roles and waits for your chat approval of the latest plan.
- Each role starts with deny-by-default, then enables its own capabilities. Broad shell/operational edits use OpenCode's normal `ask` permission until project-specific allowlists are agreed.
- Only External has MCP/web/Code Mode permissions. MCP action patterns use the example server aliases `jira`, `github`, `figma`, and `stitch`; customize these to the actual normalized server/tool IDs. They do not create connections.
- Operator owns local Git/worktrees/memory; External owns remote Git/services. Shell deny rules for common remote commands support that convention, but are not a security sandbox against scripts or aliases.
- The installer appends the [security guardrails](../SECURITY.md#security-guardrails) last to every compiled role (they are not in these sources): read/edit deny for sensitive paths, and shell deny for destructive Git on roles that have shell. `.env` reads stay `ask`.
- Implementer writes approved source/test changes. Reviewer/QA may run configured commands, but do not silently fix source. Required verification is independent of optional evidence capture.
- Explicit models are unchanged. Validate every model/variant before delegation. Spark failed on the tested ChatGPT connection; Operator/External require an explicitly approved mapping or supported connection before a full pilot. No automatic model substitution.

## Capability and ownership contract

The role descriptions below state intended workflow capabilities, not a guarantee
that a request actually receives a tool. Keep distinct: tools offered to the current
request, effective configured allow/ask/deny policy (including overrides), an
observed invocation/result, and task ownership. A catalog or permission rule is not
execution evidence; a successful call proves only that call in that session. Report
unobserved availability as unverified.

Native `shell` is separate from Code Mode `execute` catalog search. Empty catalog
results do not enumerate native tools. Direct MCP tools and nested Code Mode actions
are distinct routes; verify the actual route and configured action rather than
assuming one implies the other. If a tool is missing or denied, report the observed
error/outcome and escalate to the role owner; do not broaden permissions, substitute
a role/model, invent a tool route, or retry/restart automatically. Permission dialogs
authorize tool operations, not plans. See the [workflow capability matrix](../docs/opencode-native-workflow.md#roles-and-access)
and [troubleshooting guide](../docs/tool-troubleshooting.md).

| Role | Intended capability | Owner / escalation |
| --- | --- | --- |
| Lead | Read/search, questions, named-role delegation; no implementation or publishing tools | Human decisions and sequencing; delegate to named capability owner |
| Operator | Read/search, ASK shell/edit for local operations | Local Git, worktrees, memory, cleanup; remote/service work goes to External |
| External | Read/search, ASK shell/web/Code Mode/MCP | Services, MCP, remote Git and approved publishing; escalate access gaps to Lead |
| Researcher | Read/search only | Local research; request Git from Operator and service context from External |
| Planner | Read/search only | Planning only; request missing context through Lead |
| Implementer | Read/search/edit, ASK shell | Approved source/tests; request Git from Operator and services from External |
| Reviewer | Read/search, ASK shell | Independent review/configured checks; report findings and missing prerequisites |
| QA | Read/search, ASK shell | Runtime/design/E2E verification; report findings and missing setup |

## Installation

Run `npm run harness:install` from this checkout. The [interactive installer](../docs/installation.md) reads global/project JSON/JSONC configuration, asks for a model and reasoning variant for every role, and installs the native definitions inline in `agents` after confirmation. It supports project/global scope, preserves unrelated settings/comments, and backs up an existing target under `$HOME/Projects/advanced-harness-backups`. It does not deploy anything merely by cloning or running tests, authenticate models/MCP, or install the historical plugin.

Inline installation avoids the earlier `agent/` versus `agents/` directory discrepancy. Existing named Markdown definitions cause an abort so that competing prompts/permissions are resolved deliberately, not overwritten. Review existing inline role collisions in the summary; their owned native fields are replaced only when you type `install`.

After installation, agree visible project/worktree/memory paths, commands, model access, and actual MCP aliases. Configure/authenticate Jira/GitHub/design MCP through OpenCode (`opencode mcp list`, then `/mcps` for sign-in). Inspect effective config and all eight agents, start a new Lead session, and explicitly verify its model/variant. Pilot a small issue with conversational plan approval and final publishing approval; static tests do not prove live behavior.

OpenCode `ask` dialogs authorize a tool operation; they are not approval of a plan. Conversational approval is an instruction followed by the agents, not a deterministic gate. Use [`harness:setup`](../docs/project-setup.md) to put project commands/device/shared paths directly into AGENTS.md or referenced context. Configure [reusable optional integrations globally](../docs/configuration.md); project identifiers/mappings stay in context. Actual tools/devices/access still need validation. See the root README for the delivery order.
