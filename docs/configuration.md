# Global connections and project context

## Separation

| Settings | Location |
| --- | --- |
| Reusable MCP connections and agent permissions | Global host configuration (e.g. `~/.config/opencode/opencode.json(c)` for OpenCode, or host-specific config for Claude Code, Antigravity, Codex, Cursor) |
| Default GitHub backend/host or MCP alias; optional Jira/design aliases | Global `harness.integrations.json` |
| Repository, chosen optional services, Jira project/status mapping, build/test/device/worktree/memory settings | Project `AGENTS.md` (host-neutral project context, shared across all installed hosts) |

Global preferences contain **no repository names, Jira project keys/status mappings, or credentials**. Credentials stay in host/GitHub CLI stores or environment references. Project settings live in the host-neutral `AGENTS.md` and are preserved without modification across multiple hosts in the same workspace. Each host operates with its own scoped receipts, backups, and configurations without clobbering other hosts.

## 1. Global connections/defaults

From the harness checkout:

```powershell
npm run harness:integrations -- --scope global
```

Global scope is the default suggestion when no `--project` is supplied. Every selection is optional:

Integration setup currently configures OpenCode only. `--host opencode` (the default) is supported; unsupported hosts and `all`/multi-host selections fail before discovery, checks, or writes. This does not imply that integration adapters exist for the other installation hosts.

Workflow source compilation can emit deterministic host-specific command/skill artifacts, but that library output is not installation. Native role, permission, MCP, and runtime integrations for Claude Code, Codex, and Cursor are tracked in issues #43, #45, and #46 (Antigravity native adapter is implemented in issue #44). Installer and updater reject any selection containing an unsupported host before invoking adapters or mutating files; do not treat generated caller-bound invocation artifacts as installed reusable commands.

- GitHub: **`gh`**, **`mcp`**, or **`none`**.
- Jira: existing MCP alias, supplied new server, or **`none`**.
- Design: **`figma`**, **`stitch`**, or **`none`**. No silent combination/fallback.

Choose an existing alias/list number to preserve its complete settings. Global setup never copies project connections/credentials into global config automatically. New entries support supplied HTTPS remote OAuth endpoints (loopback HTTP is allowed), reject credentials/query strings/fragments, and stay **disabled**. Configure custom local/header-auth servers explicitly in OpenCode first, then reuse them. No endpoint is invented.

Selecting `gh` asks for a host (`github.com` or Enterprise), not an MCP URL. It does not install or authenticate GitHub CLI.

Selected MCP aliases get appended native rules: **External ask**, other seven harness roles **deny**; this preserves ASK for unresolved MCP tool mappings. External's Code Mode `execute` action is allowed, but does not authorize a conversationally unapproved operation. Selecting `gh` adds broad `gh *`/`gh.exe *` ASK rules, then narrow External-only shell ALLOW exceptions for read-only `pr view` and `pr create/edit/comment/review`, `issue create/edit/comment`, `workflow run`, and `run rerun/cancel`; `gh api` remains ASK and matching `pr merge` commands are explicitly DENY. Exact and argument-bearing commands are covered. Native `git push` is allowed for External only; other Git commands remain ASK. The other seven harness roles retain their deny rules. All eight native inline roles must be installed/visible with intended modes when writing these rules; all-none requires no permission changes. Matching appended rules take precedence; review existing explicit denies. Colliding normalized aliases or overlapping permission prefixes abort. Ordinary command patterns are workflow conventions, not a sandbox against scripts/aliases/absolute paths.

Permission ALLOW only removes the tool prompt for a matching operation; it does not supply conversational approval. External must obtain human authorization for writes. CI run/rerun/cancel and force/delete pushes require an explicit human request; final implementation approval remains required before publication. `gh pr merge` stays denied and merging remains human-only. Do not infer that `execute` or MCP permission allows a bypass of these responsibilities.

`none` changes preferences; it does **not** delete/disable existing reusable connections or revoke old grants. Other projects may still need them. Repeated identical setup is idempotent. Native installation and global integration setup now use the same pure permission planner and cumulative v2 receipt chain. Switching selections retires only integration requirement sources; shared native requirements remain active. Obsolete owned rules default to keep, with individually selected removal and final confirmation. Matching preexisting rules remain unowned. Broad GH fallback rules precede narrower constraints; ambiguous identities/order/overlap or attempts to override user denies abort. Only attributable native universal defaults may be refined by a selected integration; matching legacy defaults alone are not ownership evidence. Project scope and all-none do not revoke permissions. Inspect the additions/removals/final-order preview and keep the complete recovery chain; see [cumulative recovery receipts](installation.md#cumulative-v2-recovery-receipts).

The final review lists settings, new endpoints/disabled state, permission changes, and files. Type **`integrations`** to save. Existing targets get exact private backups under `$HOME/Projects/advanced-harness-backups`. Cancellation writes nothing. `--config` can select either global JSON/JSONC file when both exist; it cannot target project config. No runtime checks, OAuth, enabling, service tools, model requests, or publishing run while saving.

## 2. Project context selections

```powershell
npm run harness:integrations -- --scope project --project "$HOME/Projects/MarsRoverIA"
```

This uses global defaults as suggestions, but each project can independently choose **none**. It reads available aliases without creating/changing servers or permissions. Configure new connections globally first. Project-only legacy aliases can be selected as references, but do not gain permissions automatically; ask for deliberate global connection/permission setup when needed.

Only selected GitHub asks for `owner/repository`; only selected Jira asks for its project key and destination statuses. Each Jira destination can be **`-`** (unconfigured), never invented or implicitly waived. Status names/IDs are not assumed to be executable transition IDs. Selected design records one source and alias. Settings remain `unverified`: saving context does not authorize lifecycle writes or publish work.

The actual settings are embedded in the marked integrations section of **`AGENTS.md`**. All other content/sections are preserved. To use another context file:

```powershell
npm run harness:integrations -- --scope project --project "$HOME/Projects/MarsRoverIA" --context docs/HARNESS.md
```

Setup lists both the selected file and the reference added to `AGENTS.md` before final confirmation. It creates no `.opencode/harness.integrations.json` or project OpenCode config. **Project scope writes context files only.** App sources, global preferences, permissions, and existing local OpenCode overrides are untouched.

Android commands/device/path settings use the same context model:

```powershell
npm run harness:setup -- --project "$HOME/Projects/MarsRoverIA"
```

`--context` is supported there too. Settings and integrations use independent marked sections and preserve each other. Do not store secrets; review machine-specific paths before committing. Context must be Markdown inside the project; malformed markers/JSON, unknown fields, symlinks, and concurrent changes are refused. Multi-file writes are preflighted and individually atomic, not a transaction; partial-write failures disclose completed writes/backups without discarding newer work.

## 3. Optional checks and authentication

Approve enabling a new global connection separately, then sign in through OpenCode **`/mcps`**. Never paste tokens or start a hidden CLI OAuth flow. For GitHub CLI, install/sign in intentionally through your own terminal when needed; setup does neither.

```powershell
npm run harness:integrations -- --scope global --check
npm run harness:integrations -- --scope project --project "$HOME/Projects/MarsRoverIA" --check
```

All-none makes **no OpenCode/gh calls** and is not a blocker. Otherwise type **`inspect`** to approve the described read-only checks:

- MCP selections: `/api/mcp` connection status through OpenCode CLI authentication/connection flow. This may start OpenCode and enabled MCP connections/local processes, including unrelated servers. Nothing is enabled, reloaded, or restarted by the check.
- GitHub `gh`: `gh --version` and `gh auth status --hostname <host>`. Auth status may contact GitHub. Raw output/tokens are suppressed; no login/repository writes.

Optional `--opencode` and `--server` apply to checks only. Global checks can use `--project` to inspect the runtime location used by the UI; project overrides can affect effective connection identities/permissions. Check the intended location/server, not just global file presence.

Status output distinguishes missing/disabled/pending/failed/needs-auth/connected servers and unavailable/unverified CLI auth. Exit 0 means selected status checks passed (or none selected), 1 means a selected check is not ready, and 2 means verification is inconclusive. No stored context/preferences are changed into claimed verified access results.

**Connection/auth status does not prove exact tools, repository/project access, or permissions.** The documented MCP status API does not expose the tool catalog. The printed Lead prompt asks External for catalog-only discovery, then a separately approved read-only validation plan. Missing integrations require a question only when a task needs them. No automatic fallback, PR, issue transition/comment, design write, push, or merge is authorized.

Native shell is separate from Code Mode's catalog. An empty search or a child's
self-report does not establish tool absence; require an actual authorized
invocation/error or captured offered-tool evidence, otherwise mark availability
unverified. See [tool troubleshooting](tool-troubleshooting.md). Printed guidance
does not authorize running diagnostics or change installed agent prompts.

For every capability report separately what was offered to the current request, what
the effective permissions configure (including project/session overrides and order),
what invocation/result was actually observed, and which role owns the operation.
Direct MCP actions and nested Code Mode actions are separate routes: neither a selected
alias nor a catalog match proves the other route works. Missing or denied access is
escalated to its owner; do not broaden permissions or substitute roles/models. A
permission dialog authorizes a tool operation, not a plan.

## Existing profiles and settings

Existing `.opencode/harness.project.json`, `.opencode/harness.integrations.json`, and local OpenCode configs are **not deleted, overwritten, or promoted globally**. If no embedded section exists, setup offers legacy data as suggestions only after you type **`migrate`**. Final setup/integrations confirmation still approves the new context section. Declining migration leaves the old files untouched and starts from current suggestions.

Check mode does not automatically read legacy profiles. Rerun the respective setup intentionally to create context, review it, and decide separately whether obsolete local files/config overrides should eventually be removed. Never discard unrelated Android work.

## 4. Antigravity desired model preferences

Antigravity installation/update can record a desired human-readable label for each
of the eight roles. These are instructional preferences, not runtime model
assignments, discovered provider IDs, entitlement evidence, or access checks. The
existing Antigravity runtime tiers remain unchanged.

Global-scope choices are stored in
`~/.gemini/config/harness.model-preferences.json` and act only as suggestions for
project setup. Project scope never writes that global file. By default, project
choices are stored in a dedicated marked section of `AGENTS.md`; select another
in-project Markdown file explicitly with `--context`:

```powershell
npm run harness:install -- --host antigravity --scope global
npm run harness:install -- --host antigravity --scope project --project "$HOME/Projects/MarsRoverIA"
npm run harness:install -- --host antigravity --scope project --project "$HOME/Projects/MarsRoverIA" --context docs/HARNESS.md
npm run harness:update -- --host antigravity --scope project --project "$HOME/Projects/MarsRoverIA" --context docs/HARNESS.md
```

The three numbered UI labels shown by the prompt (Claude Opus 5.5, Claude Sonnet
5.5, Gemini 4 Argon) are user-observed examples only. Choose an arbitrary label or
leave a role unconfigured if appropriate; the installer does not discover or
validate those names. The review previews all role preferences and files. Existing
preference values are shown as defaults; Enter accepts the displayed default and
invalid numbered choices are retried. Cancellation before final confirmation makes
no preference, context, backup, or receipt writes. Updates preserve the earliest
managed-file before-state in the existing receipt lifecycle; malformed preference
data, concurrent changes, or uninstall conflicts stop rather than overwrite.

These preferences do not automate switching the Lead or child model. Actual model
selection, catalog discovery, entitlement, and exact-model binding remain separate
unresolved validation; issue #70 acceptance remains outstanding.
