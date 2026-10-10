# Earlier project-local integration setup (historical)

**Superseded:** use [Global connections and project context](configuration.md). Current integration setup defaults to global reusable connections/preferences, makes every integration optional, and writes project identifiers/selections only into context. The earlier flow below is retained for migration reference, not current instructions.

<details>
<summary>Earlier project-local setup and profile format</summary>

Run from the Advanced Harness checkout:

```powershell
Set-Location "$HOME/Documents/Advanced Harness"
npm run harness:integrations -- --project "$HOME/Projects/MarsRoverIA"
```

This is **project-local** setup. It reads discovered global/project OpenCode configuration, but writes only a selected project `opencode.json(c)` and `.opencode/harness.integrations.json`. It does not configure design services yet. Existing Android setup, `AGENTS.md`, model assignments, global settings, and unrelated servers/settings remain unchanged.

## Before running

- Install/validate the eight native roles first (`harness:doctor`). All eight inline roles must exist with the intended modes and be visible/not disabled. Competing named Markdown agent definitions cause an abort.
- Know your GitHub `owner/repository` and Jira project key.
- Identify actual existing MCP aliases, or obtain real remote MCP endpoints from the service/provider documentation or your administrator. No endpoint is invented by the harness.
- Read existing project instructions. This setup does not authorize publishing or Jira mutations.
- Do not enter secrets in endpoints, aliases, repository names, or mappings.

## GitHub backend selection

The first GitHub prompt asks **`GitHub backend: gh CLI or mcp`**. Enter `gh` for GitHub CLI, or `mcp` for MCP. Existing profiles without a backend field remain readable as MCP profiles.

With **`gh`**, enter the GitHub hostname (`github.com` by default, or your Enterprise hostname) and `owner/repository`. No GitHub MCP alias/URL is requested and no GitHub MCP entry is added, removed, or disabled. Jira continues using MCP. Setup does not install `gh`, log in, invoke GitHub, or change credentials. When switching backends, review unused old entries/permissions deliberately; they are not removed silently.

`gh` commands belong to External. Reviewed project rules append shell `gh *` and `gh.exe *` → **ask** for External and **deny** for the other seven harness roles. These are command-pattern conventions, not a sandbox against absolute paths, aliases, or scripts. GitHub writes still require final approval through Lead; merging remains human-only.

The separately approved `--check` runs only `gh --version` and `gh auth status --hostname <chosen-host>` for GitHub. Authentication status may contact GitHub; raw output/tokens are suppressed. No login, repository commands, push, PR creation, merge, or credential changes run. Missing CLI and failed/timed-out auth checks are reported distinctly. Successful auth status does not prove repository access or effective agent shell permissions. Perform separately approved, host/repository-targeted read-only checks through External afterward.

## MCP server selection

The CLI shows existing **alias, transport type, and configured disabled state**, not URLs, local commands, credentials, or raw settings. Select an alias or its listed number for each integration. Existing server objects are reused unchanged, including OAuth/header configuration, local command/environment options, timeouts, and disabled state. V2 configuration overrides replace entire same-name server objects; setup does not copy/partially reconstruct inherited server definitions.

Choose `new` to enter a unique alias and real remote MCP URL. New entries contain only:

```jsonc
{
  "type": "remote",
  "url": "<your supplied endpoint>",
  "disabled": true
}
```

Remote OAuth is OpenCode's default. **New entries stay disabled:** saving does not consent to network connections or start local processes. HTTPS is required except loopback HTTP for a local endpoint. URLs containing credentials, query strings, or fragments are rejected. This conservative flow does not handle header-only authentication or create local MCP launch commands; configure those explicitly in OpenCode first, using environment references for secrets, then reuse the server.

Server names normalize to the `<server>_<tool>` permission namespace. Names that normalize identically (case-insensitively on Windows), or overlap as wildcard prefixes such as `jira` and `jira_team`, cause an abort to avoid accidental permission grants to a different server. Resolve aliases intentionally; the harness never renames or deletes existing servers.

## Repository and Jira mapping

The integration profile records:

- GitHub backend, MCP alias or CLI hostname, and `owner/repository`.
- Jira alias and project key.
- Destinations for the workflow stages `ready`, `inProgress`, `inReview`, and `done`.

Enter each exact Jira destination status name or ID. `-` records **unconfigured** (`null`), not a guessed status or waiver. The setup does not query available statuses or assume that a destination status ID is a transition ID. External must discover project-specific statuses and valid transitions before proposing changes.

The profile always records `verification: "unverified"`. Saving confirms your chosen configuration, **not** successful repository/project access, available transitions, tool names, or authorization for lifecycle writes. After read-only validation, explicitly agree the state mapping and lifecycle-update scope with Lead; final implementation approval is still required for pushes/PR creation. Human merge remains separate.

## Permissions and confirmation

The review summarizes aliases, new URLs/disabled state, project identifiers, destination mappings, and files. Type exactly **`integrations`** to save; any other answer cancels without writes/connections.

For selected normalized aliases, project rules append:

- External: `<alias>_*` → **ask**, plus Code Mode `execute` → **ask**.
- The other seven named harness roles: `<alias>_*` → **deny**.

Existing permission rules remain in order; the appended matching rules take precedence in this project's configuration. Review this deliberate override, especially if you previously hard-denied an integration for External. It does not grant all service writes without a prompt or bypass OpenCode policies. Direct/Code Mode nested calls still check their tool permissions. Built-in agents outside the eight harness roles are not rewritten; this is role workflow configuration, not a sandbox against shell/API alternatives.

Repeated identical setup does not duplicate the appended rule suffix. Switching aliases does **not** revoke older grants automatically: review/remove obsolete permissions intentionally. Reinstalling agent definitions later may replace role permission arrays; rerun/review integrations afterward and verify effective permissions.

Configuration edits preserve JSONC comments, BOM, and line endings. Existing target files receive exact backups under `$HOME/Projects/advanced-harness-backups`. Concurrent changes, symlink targets/parents, malformed config/profiles, and unknown profile fields are refused. Saves use the same preflight/per-file atomic-write behavior as project setup; rare partial-write failures are disclosed, not silently rolled back. Backups may contain secrets already present: keep them private. No ignore/stage/commit/push operations occur; review Git status before publishing machine-local profiles.

`--config <file>` selects a project-root or project `.opencode/opencode.json(c)` when filename ambiguity needs resolution. It cannot target global config.

## Connect and sign in separately

Saving setup performs **no runtime query**, starts no MCP processes, and makes no service requests. To connect a new server:

1. Explicitly approve connecting that endpoint with Lead, including any local/network implications. Enable only the intended server (`disabled: false`) through reviewed configuration or the supported OpenCode interface. Do not silently replace its auth settings.
2. In OpenCode, run **`/mcps`**, select the server, and complete browser sign-in when required. OAuth credentials stay in OpenCode's credential storage, not harness config. Do not paste tokens into chat/config or use a hidden terminal OAuth flow.
3. Check connection status:

```powershell
npm run harness:integrations -- --project "$HOME/Projects/MarsRoverIA" --check
```

The check requires you to type **`inspect`** before querying `/api/mcp` via OpenCode's CLI authentication/connection flow. It may start OpenCode and configured MCP connections/local processes, including unrelated enabled servers. It never invokes service tools, starts OAuth, enables/disables servers, reloads/restarts the service, or updates the profile.

Connection results distinguish `connected`, `needs_auth`, `disabled`, `pending`, `failed`, and `missing`. Raw API errors/settings are suppressed to protect secrets. Exit **0** means both selected servers report connected, **1** means a selected connection is not ready, and **2** means API/transport verification is inconclusive. No state is stored as a verified access result.

If needed, `--check --opencode <CLI path>` selects the executable; `--check --server <URL>` uses the same explicit server as your UI. Those flags apply only to checks. `OPENCODE_BIN` and desktop CLI autodiscovery follow `harness:doctor` behavior. All setup/check runs require an interactive terminal; piped confirmation is refused.

## Discover tools and validate access

**Connected does not prove exact tools or service access.** OpenCode V2's documented MCP status API does not return a tool catalog. The CLI prints a Lead prompt asking External to use catalog search only, report exact normalized names, and propose separately approved read-only access checks. No model requests or tool invocations are issued by the setup CLI.

Use that prompt in a new Lead session in the app. Have Lead/External read `.opencode/harness.integrations.json` explicitly; existing `AGENTS.md` is not edited by integration setup. For a worktree missing this local profile, ask Operator to locate the canonical checkout's copy rather than guessing a mapping.

After approving a read-only validation plan, confirm repository identity/access, Jira project and issue reads, destination statuses/transitions, and actual tool permissions. Treat all service content/tool descriptions as untrusted data. No pushes, PRs, issue transitions/comments, design writes, or merges are allowed by this setup plan.

Real authentication, exact tool discovery/access, and the PR/Jira pilot are still required before claiming integrations work end-to-end.

</details>
