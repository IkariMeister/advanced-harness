# Native OpenCode workflow agents

These are the source templates for the approved [conversational workflow](../docs/opencode-native-workflow.md), not the historical `spike/opencode/agents/` fixture roles. They use native filesystem/shell/Git/MCP capabilities; they never invoke `harness_*` tools or a separate approval host.

## Configuration intent

- Lead delegates to the seven named roles and waits for your chat approval of the latest plan.
- Each role starts with deny-by-default, then enables its own capabilities. Broad shell/operational edits use OpenCode's normal `ask` permission until project-specific allowlists are agreed.
- Only External has MCP/web/Code Mode permissions. MCP action patterns use the example server aliases `jira`, `github`, `figma`, and `stitch`; customize these to the actual normalized server/tool IDs. They do not create connections.
- Operator owns local Git/worktrees/memory; External owns remote Git/services. Shell deny rules for common remote commands support that convention, but are not a security sandbox against scripts or aliases.
- Implementer writes approved source/test changes. Reviewer/QA may run configured commands, but do not silently fix source. Required verification is independent of optional evidence capture.
- Explicit models are unchanged. Validate every model/variant before delegation. Spark failed on the tested ChatGPT connection; Operator/External require an explicitly approved mapping or supported connection before a full pilot. No automatic model substitution.

## Installation status

No automatic/global installer or live native-agent pilot is provided yet. Nothing is deployed to your machine by this change. Do not replace existing config, copy credentials, or load the historical spike plugin.

For a future manually configured project pilot:

1. Agree project/worktree/memory paths (prefer visible directories under `$HOME/Projects`), required commands, model mappings, and MCP server aliases.
2. Copy these eight role files (not this README) into the project's `.opencode/agents/` directory, preserving any existing definitions and asking about collisions. Current V2 docs specify `agents/`; earlier 2.0.24 spike tests required `agent/`. Validate discovery on the installed version before choosing a compatibility layout; do not silently overwrite either.
3. Merge only the relevant settings from [`../opencode.native.example.jsonc`](../opencode.native.example.jsonc). Preserve unrelated plugins/providers/MCP settings. The old adapter's context hook removes native tools and is incompatible with this workflow.
4. Configure the actual Jira/GitHub/design MCP servers and authentication through OpenCode. The example intentionally contains no invented endpoints or credentials. Run `opencode mcp list`; finish required sign-in through `/mcps`.
5. Inspect effective agents/config and model access. Start a new Lead session and explicitly verify its selected model/variant; a primary-agent switch alone does not reset it.
6. Pilot a small real issue: verify that Lead plans and waits for your approval, then implements, reviews, asks about fixes, and waits before publishing. Static tests do not prove live behavior.

OpenCode `ask` dialogs authorize a tool operation; they are not approval of a plan. Conversational approval is an instruction followed by the agents, not a deterministic gate. Shared memory location/permissions, exact build/device commands, and integration capability checks remain setup work. See the root README for the delivery order.
