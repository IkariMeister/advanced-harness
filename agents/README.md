# Native OpenCode workflow agents

These are the source templates for the approved [conversational workflow](../docs/opencode-native-workflow.md), not the historical `spike/opencode/agents/` fixture roles. They use native filesystem/shell/Git/MCP capabilities; they never invoke `harness_*` tools or a separate approval host.

## Configuration intent

- Lead delegates to the seven named roles and waits for your chat approval of the latest plan.
- Each role starts with deny-by-default, then enables its own capabilities. Broad shell/operational edits use OpenCode's normal `ask` permission until project-specific allowlists are agreed.
- Only External has MCP/web/Code Mode permissions. MCP action patterns use the example server aliases `jira`, `github`, `figma`, and `stitch`; customize these to the actual normalized server/tool IDs. They do not create connections.
- Operator owns local Git/worktrees/memory; External owns remote Git/services. Shell deny rules for common remote commands support that convention, but are not a security sandbox against scripts or aliases.
- Implementer writes approved source/test changes. Reviewer/QA may run configured commands, but do not silently fix source. Required verification is independent of optional evidence capture.
- Explicit models are unchanged. Validate every model/variant before delegation. Spark failed on the tested ChatGPT connection; Operator/External require an explicitly approved mapping or supported connection before a full pilot. No automatic model substitution.

## Installation

Run `npm run harness:install` from this checkout. The [interactive installer](../docs/installation.md) reads global/project JSON/JSONC configuration, asks for a model and reasoning variant for every role, and installs the native definitions inline in `agents` after confirmation. It supports project/global scope, preserves unrelated settings/comments, and backs up an existing target under `$HOME/Projects/advanced-harness-backups`. It does not deploy anything merely by cloning or running tests, authenticate models/MCP, or install the historical plugin.

Inline installation avoids the earlier `agent/` versus `agents/` directory discrepancy. Existing named Markdown definitions cause an abort so that competing prompts/permissions are resolved deliberately, not overwritten. Review existing inline role collisions in the summary; their owned native fields are replaced only when you type `install`.

After installation, agree visible project/worktree/memory paths, commands, model access, and actual MCP aliases. Configure/authenticate Jira/GitHub/design MCP through OpenCode (`opencode mcp list`, then `/mcps` for sign-in). Inspect effective config and all eight agents, start a new Lead session, and explicitly verify its model/variant. Pilot a small issue with conversational plan approval and final publishing approval; static tests do not prove live behavior.

OpenCode `ask` dialogs authorize a tool operation; they are not approval of a plan. Conversational approval is an instruction followed by the agents, not a deterministic gate. Shared memory location/permissions, exact build/device commands, and integration capability checks remain setup work. See the root README for the delivery order.
