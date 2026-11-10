# Global connections and project context

## Separation

| Settings | Location |
| --- | --- |
| Reusable MCP connections and agent permissions | Global host configuration (e.g. `~/.config/opencode/opencode.json(c)` for OpenCode, or host-specific config for Claude Code, Antigravity, Codex, Cursor) |
| Default GitHub backend/host or MCP alias; optional Jira/design aliases | Global `harness.integrations.json` |
| Global project defaults: suggested base branch, shell, checks, device preference, and worktree/memory parent directories | `~/.config/advanced-harness/project-defaults.json`, or under `$XDG_CONFIG_HOME` when set (host-neutral) |
| Repository, chosen optional services, Jira project/status mapping, build/test/device/worktree/memory settings | Project `AGENTS.md` (host-neutral project context, shared across all installed hosts) |

Global preferences contain **no repository names, Jira project keys/status mappings, or credentials**. Credentials stay in host/GitHub CLI stores or environment references. Project settings live in the host-neutral `AGENTS.md` and are preserved without modification across multiple hosts in the same workspace. Each host operates with its own scoped receipts, backups, and configurations without clobbering other hosts.

## 1. Global connections/defaults

From the harness checkout:

```powershell
npm run harness:integrations -- --scope global
```

Global scope is the default suggestion when no `--project` is supplied. Every selection is optional:

Integration setup currently configures OpenCode only. `--host opencode` (the default) is supported; unsupported hosts and `all`/multi-host selections fail before discovery, checks, or writes. This does not imply that integration adapters exist for the other installation hosts.

Workflow and canonical procedure source compilation can emit deterministic host-specific command/skill artifacts, but compilation alone is not installation. Native adapters are available for OpenCode, Antigravity, and Claude Code (project/global scope; runtime-unverified), including receipt-managed canonical procedure skills. Codex installs at global scope with one process per role (issue #45); Codex procedure skills are compilation-only and are not deployed by its lifecycle. Cursor remains tracked in issue #46. Installer and updater reject unsupported or mixed selections before mutation.

`harness:doctor` statically validates canonical procedure skills and checks the expected emitted skill name, description/frontmatter, and intended-role advisory guidance for OpenCode, Claude Code, and Antigravity. It does not require byte-identical bodies, since installed skill bodies can be customized. A missing expected skill is an error only when a harness installation footprint is detected; otherwise the result is reported as not installed/not checked. Existing expected artifacts can still be inspected without a footprint. Unrelated third-party skills are ignored. Role guidance is advisory only: doctor does not discover/enforce role authorization or grant permissions. Codex and Cursor procedure-skill native deployment is unsupported; their canonical sources can still be statically validated. These checks do not establish runtime discovery/invocation or permissions/enforcement. OpenCode runtime/catalog diagnostics are retained separately, and static results are shown even when runtime verification is inconclusive.

| Host | Canonical compilation | Native procedure-skill deployment | Doctor static validation | Runtime / exposure and permissions |
| --- | --- | --- | --- | --- |
| OpenCode V2 | Supported | Supported | Canonical + expected installed artifact | Runtime agent/catalog check is separate; skill exposure does not grant tool permissions. |
| Claude Code | Supported | Supported | Canonical + expected installed artifact | Runtime behavior unverified; skills do not establish tool permissions. |
| Antigravity | Supported | Supported | Canonical + expected installed artifact | Runtime skill exposure and enforcement are not proven by static checks. |
| OpenAI Codex | Supported | Unsupported (compilation only) | Canonical source only | No native procedure skill deployment by this lifecycle; skill metadata does not grant tools. |
| Cursor IDE | Supported | Unsupported (manual artifact compilation only) | Canonical source only | No native installation/runtime verification; no permissions are inferred. |

The five documentation procedures and their advisory intended roles are listed in
[`skills/README.md`](../skills/README.md). Run `npm run docs:check` for bounded,
offline link/path/script/workflow-command checks; this is not semantic glossary review.

### OpenAI Codex selections

**One process per role (#45).** Codex subagents inherit the parent sandbox, approval and MCP settings, so each child role runs as its own `codex exec` process with a profile in `~/.codex/harness-<role>.config.toml`, launched by Lead (your Codex Desktop session) with your host permission at the Codex Desktop prompt for every launch. Operator and External run with `danger-full-access` (no sandbox limit on writes or network), Implementer with `workspace-write`, and the other roles with `read-only`. Codex installs at global scope only. Shared-permission and prompt-only fallbacks are not used. Details: [OpenAI Codex installation](installation.md#openai-codex-global-scope-one-process-per-role).

`harness:install --host codex` and `harness:update --host codex` write `~/.codex/` files after explicit confirmation. Every child role requires a model ID and reasoning effort; an existing role's values are the Enter defaults, while a new role requires explicit values. There is no guessed preset or fallback. Choices can come from the live `model/list` catalog, with off-catalog values kept only on an explicit `keep` ([Codex model discovery](installation.md#openai-codex-global-scope-one-process-per-role)). Required answers allow at most three invalid attempts; a closed/rejected prompt aborts before writes. Enter preserves previously selected MCP servers and their disabled-tool entries; enter `-` to clear only selection tracking (it does not re-enable servers or remove disabled tools). Only servers defined in `config.toml` can be selected: child role processes run with Codex plugins disabled, so a plugin-provided MCP server cannot be selected for External (#209). Your own content in `~/.codex/AGENTS.md` is kept: the harness changes only its managed Lead block there, and uninstall removes only that block. Workflow skills use `.agents/skills/<name>/SKILL.md`; existing differing skills are preserved because that directory may be shared with other hosts.

Codex install/update and doctor share one bounded, offset-preserving TOML scanner for basic tables, dotted/quoted keys, scalar values, arrays, and inline tables. Comments, whitespace, line endings, and untouched source slices are preserved. Unsupported multiline strings/arrays, array-of-table forms, and TOML syntax outside this subset are refused rather than normalized. `harness:uninstall --host codex --scope global` restores the receipt-managed files and reverses only the harness's own `config.toml` edits; values changed since install, including a customized `disabled_tools` list, are kept and listed ([Codex uninstall](installation.md#openai-codex-global-scope-one-process-per-role)). Codex runtime behaviour, including an approved role launch, is not yet verified by this harness.

The Codex config scanner remains fail-closed for multiline arrays (no parser expansion
is attempted). A malformed existing role profile does not block questions for all
required explicit assignments; defaults are inferred only from a successfully parsed
role. The installer then asks whether to preserve (default) or explicitly overwrite
the malformed role, retaining its exact bytes when overwrite is declined.

The adapter adds `sandbox_mode = "read-only"` and `approval_policy = "on-request"` only when absent; existing user values are preserved. These shared settings affect Codex as a whole, not individual role identities. They are a conservative generated baseline, **not proof that every write route requires a human host permission**. Codex project configuration is subject to the host's project-trust behavior. The direct shell rule rejects identifiable `gh pr merge` / `gh.exe pr merge` prefixes only; scripts, MCP/API calls, and other indirect routes are not universally blocked. Because Operator and External run with `danger-full-access`, the managed rules' enforcement for them is unverified, and Operator's `git push`, `git pull`, `git clone`, and `gh` denies are instruction-only.

MCP entries are never invented. The installer asks for actual server IDs already present in the target config and exact tool names, then marks selected server entries `enabled = false` and adds supplied names to `disabled_tools` pending separate route validation. It does not enable/authenticate servers or claim tool-level approval behavior. Existing configuration and credentials are preserved; malformed or unsupported TOML is refused. Cancellation makes no changes or backups, repeated identical updates are idempotent, and updates create cumulative host-scoped recovery receipts. If a write fails, the adapter attempts guarded reverse-order restoration only where live files still match its expected write; concurrent divergent edits are preserved and pending recovery evidence is retained for manual recovery.

- GitHub: **`gh`**, **`mcp`**, or **`none`**.
- Jira: existing MCP alias, supplied new server, or **`none`**.
- Design: **`figma`**, **`stitch`**, or **`none`**. No silent combination/fallback. For interactive verification and manual smoke steps, see [`docs/design-integration-validation.md`](design-integration-validation.md).

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

`--context` is supported there too. Settings and integrations use independent marked sections and preserve each other. Worktree and memory paths under your home directory are saved as `$HOME/...` so they can be committed; agents read them from context and ask only when they are missing, invalid, or conflicting ([how shared locations resolve](project-setup.md#how-shared-locations-resolve)). Do not store secrets; review any absolute, machine-specific paths before committing. Context must be Markdown inside the project; malformed markers/JSON, unknown fields, symlinks, and concurrent changes are refused. Multi-file writes are preflighted and individually atomic, not a transaction; partial-write failures disclose completed writes/backups without discarding newer work.

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

Status output distinguishes missing/disabled/pending/failed/needs-auth/connected servers and unavailable/unverified CLI auth. Exit 0 means selected status checks passed (or none selected), 1 means a selected check is not ready, and 2 means verification is inconclusive. No stored context/preferences are changed into claimed verified access results. Detailed read-only verification smoke steps, exit code matrices, and capability reporting expectations are documented in [`docs/design-integration-validation.md`](design-integration-validation.md).

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

Global project defaults saved by an earlier version at `~/.config/opencode/harness.project.json` keep working as a read-only fallback until the new file exists. Only `harness:setup --global` moves them, after you type **`migrate`** and then **`save`**; the old file is never edited or deleted. See [global project defaults from an older version](project-setup.md#global-project-defaults-from-an-older-version).

## 4. Antigravity desired model preferences

Antigravity installation/update can record a desired human-readable label for each
of the eight roles. These are instructional preferences, not runtime model
assignments, discovered provider IDs, entitlement evidence, or access checks. They
do not change the Antigravity runtime tiers, which are chosen separately per child
role during the same install/update ([Google Antigravity](installation.md#google-antigravity)).

Global-scope choices are stored in
`~/.gemini/config/harness.model-preferences.json` and act only as suggestions for
project setup. Project scope never writes that global file. By default, project
choices are stored in a dedicated marked section of `AGENTS.md`; select another
in-project Markdown file explicitly with `--context`:

Before an Antigravity install/update proceeds, receipt-managed preference files
and context Markdown files must still match their recorded after-state. A changed,
missing, unsafe, or unreadable managed file stops the operation rather than
silently absorbing edits. This is a whole-file check: restore or resolve the
file explicitly before retrying. It does not apply a general drift policy to
other deployment artifacts.

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

These preferences do not automate switching the Lead or child model. Child runtime
tiers are selected explicitly at install/update; exact per-role model binding and
catalog discovery are unsupported on Antigravity, and entitlement remains unverified.
