# ADR-0013: External `* -> ask` Default for User-Installed MCP Servers

## Status
Accepted

## Context
In OpenCode, MCP tool names are prefixed by the user's configured server key (for example `figma-dev-mode-mcp-server_get_code` or `firebase-mcp-server_*`). When `external` used `{ action: "*", resource: "*", effect: "deny" }`, any user-installed MCP server not matching a hardcoded rule was silently denied unless the user re-ran `harness update` or manually edited permissions.

## Decision
- Set `external`'s base catch-all rule to `{ action: "*", resource: "*", effect: "ask" }`.
- Explicitly `deny` `edit`, `subagent` delegation, and `skill` fallback (`*`) on `external` right after `*`, while keeping `external_directory` at `ask` and all trailing security guardrails (`gh pr merge`, sensitive `read` paths, destructive `git`) at `deny`.
- Restrict `mcp.tool` capability mapping (`<prefix>*`, `/^[a-zA-Z0-9][a-zA-Z0-9._-]*\*$/`) in `src/capability-policy.ts` to `external` only.

## Consequences
- User-installed MCP servers prompt with `ask` on `external` without requiring a harness update.
- `edit`, `subagent` delegation, and unlisted `skill` loads remain `deny` on `external` under ordered-last-match.
