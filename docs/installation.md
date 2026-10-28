# Interactive native-agent installer

For macOS-specific manual prerequisites, isolated preparation steps, expected outcomes,
and failure handling, see the [macOS validation checklist](macos-validation.md). It is
preparation only; live service/model validation remains a separate approval.

## Uninstall (BH021)

Installer receipts are stored privately under `$HOME/Projects/advanced-harness-backups` or the isolated `ADVANCED_HARNESS_RECOVERY_DIR`. Receipt-backed uninstall discovers the active receipt for the selected target and host:

```text
npm run harness:uninstall -- --scope global
npm run harness:uninstall -- --scope project --project <directory>
npm run harness:uninstall -- --host claude-code --project <directory>
npm run harness:uninstall -- --host antigravity --scope project --project <directory>
npm run harness:uninstall -- --host antigravity --scope global
```

Without `--host`, uninstall targets OpenCode. `--host claude-code` restores the project footprint recorded at `<project>/.claude/settings.json`; `--scope global` is rejected because Claude Code installs are project-scoped. `--host antigravity` targets `<project>/.agents/hooks.json` (project scope) or `~/.gemini/config/hooks.json` (global scope). Each host reads only its own receipts; a receipt for one host is never restored by another. After managed files are removed, only directories the install created and that are now empty are pruned, bounded by the project root (or the Antigravity global config directory); the top-level `.claude` and `.agents` folders are left in place. Files you edited after install, including the `CLAUDE.md` or `AGENTS.md` harness block, block uninstall with a conflict and no writes; block-level removal is not performed. A missing target is never recreated during uninstall.

`--config <opencode.json|opencode.jsonc>` is OpenCode-only and is rejected with other hosts. Use it to select a specific config within that scope, or `--receipt <receipt>` to select a specific receipt. Ambiguous or invalid receipt history stops the operation; review the chain before retrying. For an existing installation, `--adopt-existing` is a separate provenance-only mode; optional `--before-config <known-before-config>` supplies same-path historical evidence. First answer **“Adopt all detected agent fields for removal?”** (default No). Yes selects only present supported fields on the eight known roles for unknown-history removal; one grouped acknowledgment is required. Root `default_agent` and `model` are always prompted separately and default to keep. No asks once per detected agent; keep is the default, and restore requires supplied same-path evidence. Per-agent removal also requires an acknowledgment. Custom agents, other fields, absent fields, and unrelated settings are excluded. An ownership/history warning precedes the grouped choice. A final `adopt` confirmation records provenance only; it changes no config and does not uninstall. A later, separate uninstall preview and `uninstall` confirmation are required. Automated prompt-flow tests compose decisions with adoption/uninstall planning; manual interactive CLI QA remains pending. Do not apply this workflow to a live installation.

### Isolated uninstall/adoption QA (no installer/runtime calls)

In a disposable PowerShell terminal, create an isolated config/evidence pair and route
recovery output to that fixture. This flow invokes only the interactive uninstall CLI;
it does not run `harness:install`, launch OpenCode, or call runtime verification:

```powershell
$qa = Join-Path $env:TEMP ('bh021-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $qa | Out-Null
$env:ADVANCED_HARNESS_RECOVERY_DIR = Join-Path $qa 'recovery'
'{"agents":{"lead":{"model":"provider/new"}}}' | Set-Content -NoNewline (Join-Path $qa 'opencode.json')
'{"agents":{"lead":{"model":"provider/old"}}}' | Set-Content -NoNewline (Join-Path $qa 'before.json')
npm run harness:uninstall -- --config (Join-Path $qa 'opencode.json') --adopt-existing --before-config (Join-Path $qa 'before.json')
```

At the bulk question answer `N`, then choose `restore` for Lead and accept default
`keep` for other detected agents and root settings; every present root default is asked
separately even if Lead is restored. Type `adopt` at the final
provenance confirmation. Verify the
config remains byte-identical and a `native-adoption-*.json` appears in recovery.
Then run receipt-backed uninstall separately using that exact receipt path; review
the preview, type `uninstall`, and confirm only the selected model field is restored.
Repeat uninstall with the same receipt to confirm no new config backup is created.
Use `--adopt-existing` without `--before-config` to validate keep-unmanaged and
acknowledged-removal behavior. Also repeat with `y` at the bulk question, acknowledge
unknown history once for the agent group, and verify the receipt contains only present
supported known-agent fields; root prompts still appear and should be kept. Test blank/default responses and refusal of the final
`adopt` confirmation on a disposable fixture, verifying the config remains unchanged
and no receipt is created. After QA, remove only this disposable `$qa` directory
and clear the process-local variable with `Remove-Item Env:ADVANCED_HARNESS_RECOVERY_DIR`.

Run from the Advanced Harness checkout with Node.js 24. The installer CLI is [`scripts/install-native-harness.ts`](../scripts/install-native-harness.ts):

```text
npm ci
npm run harness:install
```

The installer asks for project or global scope, reads existing `opencode.json`/`opencode.jsonc` files, and asks for a model and reasoning variant for **each of the eight agents**. Existing role model assignments, including expanded model objects and variants, are preserved by default; a separate per-role confirmation is required to replace one. It also prompts whether to install the canonical workflow slash commands (`/start-issue`, `/review-pr`, `/address-pr-feedback`, `/report-defect`, `/assess-debt`, `/grill-me`) into `<project>/.opencode/commands/` or `<globalConfig>/commands/`. Differing existing command files prompt for explicit confirmation before overwriting; identical files are skipped. Deployed command files are tracked under `managedFiles` in the v2 installation receipt, allowing `harness:uninstall` to cleanly remove them or restore prior customized content. Nothing is written until you review the assignments and type `install`. Enter at a model prompt explicitly accepts its displayed suggestion; there is no automatic substitution on model-access failure.

Examples:

```text
npm run harness:install -- --host opencode --scope global
npm run harness:install -- --host claude-code --scope project --project "C:/Users/you/Projects/android-app" # Claude Code project scope (not runtime-validated)
npm run harness:install -- --host claude-code,antigravity --scope project --project "C:/Users/you/Projects/android-app" # blocked: mixed-host installs are not supported
npm run harness:install -- --host all --scope project --project "$HOME/Projects/android-app" # mixed selections are refused
npm run harness:install -- --help
```

`--host <opencode|claude-code|antigravity|codex|cursor|all>` accepts host selections. OpenCode, Google Antigravity (#44), Claude Code (#43, project scope only), and Codex (#45) are implemented as single-host installs. Cursor (#46) is not implemented. Any selection containing an unimplemented host, and any mixed or `all` selection, is rejected before adapters or filesystem mutations. Without `--host`, `harness:install` and `harness:update` prompt for a single host (Enter keeps `opencode`); a comma-separated, `all`, or unknown answer is re-asked rather than rejected, so run the command once per host. Workflow artifact compilation is a pure library operation, not installation; caller-bound invocation artifacts are never automatically written as reusable commands.

Antigravity install likewise requires a typed `yes`; Enter, `no`, or any other answer cancels with no file, backup, or receipt written.

### Claude Code (project scope)

`--host claude-code --scope project` shows the planned files and the fail-closed mapping, then requires a typed `yes`. Enter, `no`, or any other answer cancels with no file, backup, or receipt written. It writes:

- `CLAUDE.md`: a marked Lead block (`<!-- advanced-harness:lead:start -->` … `<!-- advanced-harness:lead:end -->`) followed by `@AGENTS.md`. Content outside the markers is preserved. Malformed or duplicate markers are refused.
- `.claude/agents/lead.md` plus `operator`, `external`, `researcher`, `planner`, `implementer`, `reviewer`, and `qa` subagents. Models follow the README presets: Lead, Researcher, Implementer, and QA `sonnet`; Operator and External `haiku`; Planner and Reviewer `opus`.
- `.claude/commands/` with the six workflow commands.
- `.claude/settings.json`, merged: `"agent": "lead"`, deny `Bash(gh pr merge)`/`Bash(gh pr merge *)` and the `gh.exe` variants, and prompts for `.env` reads. Unrelated keys are preserved. An existing different `agent` value blocks installation.

Per-role tools use `tools` allowlists plus `disallowedTools`. Lead can read, search, ask the human, and delegate only to the seven children. Operator and Implementer can edit (prompted). External can use Bash, WebFetch, and WebSearch (prompted, with the source's allow exceptions downgraded to prompts). Operator, Implementer, Reviewer, and QA have **no Bash tool** because the source's per-role `git`/`gh` deny patterns cannot be scoped exactly in Claude Code. No MCP or Code Mode identity is mapped, so no `.mcp.json` is written. Customized files prompt with default `no`; overwrites are backed up.

Global scope is refused. The same adapter handles `harness:update --host claude-code`, which is a no-op when everything matches. `harness:doctor --host claude-code --project <dir>` checks the files, subagent frontmatter, the Lead block, and the settings rules. It does not invoke Claude Code.

Not verified here: Claude Code discovery of subagents, `agent: lead`, `Agent(...)` delegation, `tools`/`disallowedTools` semantics, Bash deny matching, or command placeholders. Run the documented human smoke before relying on these behaviors.

### OpenAI Codex

Codex install/update writes project `.codex/` or global `~/.codex/` after confirmation. Existing role model and effort values are shown as defaults; Enter preserves them. New roles have no guessed assignment and require explicit model/effort values. Enter at the MCP selection and tool prompts preserves prior tracking; `-` clears only tracking (servers stay disabled and existing disabled-tool entries remain). Invalid required assignments must be corrected before the review. Shared `AGENTS.md` and customized shared skills are preserved, and updates create cumulative recovery receipts. If saving fails, the adapter attempts reverse-order restoration only when live contents match its expected post-write state; divergent edits are preserved, and unresolved rollback retains pending recovery evidence and reports its path. Selected existing MCP routes remain disabled pending validation. Codex shared sandbox/approval settings do not prove per-role isolation or universal approval. Static doctor checks do not establish Desktop runtime behavior; see [Codex configuration limits](configuration.md#openai-codex-selections).

Integration configuration (`harness:integrations`) currently supports OpenCode only. Its `--host` option accepts `opencode`; unsupported hosts and multi-host selections (including `all`) are rejected before discovery, checks, or writes. This does not limit the separately implemented native installer adapters for Antigravity, project-scope Claude Code, and Codex.

Uninstall preflights all receipt and managed-file restore states before confirmation, then revalidates before writes. Digest-only prior content cannot authorize reconstruction or deletion. Same-basename backups are distinguished by target identity. Cancellation and no-op restores create no backups. A later unexpected I/O failure can still leave a partially completed multi-file restore; output identifies completed changes and backups for recovery rather than claiming transactionality.

### Isolated interactive restore smoke (manual)

Prerequisites: Node.js 24.x, a usable interactive TTY, and an explicitly disposable fixture root under the approved temporary directory. Never point this smoke at a real user configuration or managed file. Create two nested fixture files with the same basename, make an OpenCode test configuration and matching v2 receipt, and run the uninstall CLI against only that fixture.

1. Type anything other than `uninstall`; expect cancellation and byte-for-byte unchanged config/files, with no backup directory.
2. Repeat with valid receipt contents and type `uninstall`; expect only evidenced fixture state restored and distinct exact backups for the two same-basename files.
3. Change one fixture file after preview but before confirmation; expect a stale-evidence stop before any config/managed/backup writes.
4. Supply a digest-only prior state; expect a blocked restore without deletion/reconstruction. A digest-only after state may proceed only when the live content matches it and prior content is recoverable.
5. Repeat `npm run harness:integrations -- --host claude-code --scope global` and `--host all`; expect immediate unsupported-host rejection before discovery/checks/writes. OpenCode remains supported.

Do not use redirected stdin as interactive evidence. Record fixture location, command, and observed results; clean up only the explicitly disposable fixture after verifying no recovery evidence needs preservation.

`--project` is only for project scope. `--config <file>` selects an explicit `opencode.json` or `opencode.jsonc` within that scope, including the project's `.opencode` folder. This resolves a filename ambiguity when both JSON and JSONC exist. Paths supplied at prompts accept leading `~` or `$HOME`. Scope/destination are always shown before confirmation. Run in an interactive terminal; piped input is refused. This is setup, not the separate runtime approval terminal removed from the product plan.

## What configuration is read

- Global scope: `$XDG_CONFIG_HOME/opencode` when set, otherwise `~/.config/opencode`.
- Project scope: the global files and direct/`.opencode` files from the filesystem root through the chosen project, including ancestors above Git roots.
- Only configuration paths and model IDs are displayed. Raw provider settings, credentials, MCP headers, and agent prompts are not printed.
- Current role assignments, the root model, and provider model/variant declarations supply choices and suggestions. Expanded model objects are supported, including custom-provider deployment aliases.
- These are **filesystem declarations**, not the running server's effective model catalog or proof of account access. Environment overrides, disabled providers/models, higher-priority configuration, and connection entitlements can affect actual behavior. Check `/models` before choosing an ID/variant and validate after installation.

For project scope the installer reuses a local `.opencode` config when present. Otherwise it uses the project's direct config, except when a discovered ancestor `.opencode` config would override it: then it creates a project `.opencode/opencode.jsonc`. Both JSON and JSONC in the target directory require explicit selection; invalid or duplicate-key configuration is rejected instead of rewritten.

## Model assignment

For every role:

1. Enter `provider/model`, `provider/model#variant`, or a number from the declared model list. Enter accepts the displayed current/default/template suggestion.
2. Confirm or change the reasoning variant. **`-` means no variant**; `none` is a literal variant name, not removal. LiteLLM/custom aliases and nested model IDs such as `openrouter/anthropic/...` are allowed.

The installer does not invent provider deployment IDs, create model connections, or send a paid test request. Spark was rejected by the tested ChatGPT connection: choose a supported model explicitly or change the connection rather than accepting Spark without checking. All assignments are stored in the selected configuration's `agents.<role>.model`; source templates are unchanged.

Making Lead the default agent and changing the root default model are **separate opt-ins**. The existing root model is preserved unless you choose to change it. OpenCode's root model does not retain a reasoning variant, and existing session selections are unaffected: start a new session and verify/select Lead's assigned model and variant explicitly.

## LiteLLM integration & macOS setup

On macOS (and other environments using custom model proxies), OpenCode connects to models through a local or remote **LiteLLM proxy** (or OpenAI-compatible endpoint). The harness does not invent deployment mappings or proxy URLs; they must be explicitly declared in your global or project `opencode.json(c)`.

### 1. Declaring the LiteLLM provider in OpenCode

In your global configuration (`~/.config/opencode/opencode.json` or `$XDG_CONFIG_HOME/opencode/opencode.json`), declare the LiteLLM provider endpoint under `providers`:

```json
{
  "$schema": "https://opencode.ai/v2/config.schema.json",
  "providers": {
    "litellm": {
      "type": "openai",
      "baseURL": "http://localhost:4000/v1",
      "apiKey": "{env:LITELLM_API_KEY}",
      "models": {
        "gpt-4o": { "name": "GPT-4o (LiteLLM)" },
        "gpt-4o-mini": { "name": "GPT-4o Mini (LiteLLM)" },
        "claude-3-7-sonnet": { "name": "Claude 3.7 Sonnet (LiteLLM)" },
        "claude-3-5-haiku": { "name": "Claude 3.5 Haiku (LiteLLM)" }
      }
    }
  }
}
```

> [!IMPORTANT]
> - **Keep credentials in environment references**: Use `{env:LITELLM_API_KEY}` or your shell environment instead of hardcoding raw bearer tokens or API keys into configuration files.
> - **Exact model deployment IDs**: LiteLLM aliases must match the actual deployment identifiers configured on your LiteLLM proxy instance.
> - **Discovery precedence**: When running `npm run harness:install`, the installer automatically parses models declared under `providers.<provider>.models` and presents them as numbered choices for role assignment.

### 2. Mapping roles to LiteLLM models

When running `npm run harness:install -- --host opencode`, assign each of the 8 roles to your verified LiteLLM models:

| Role | Responsibility | Suggested LiteLLM model | Reasoning variant |
| --- | --- | --- | --- |
| **Lead** | Coordinates subagents, plan approvals | `litellm/gpt-4o` or `litellm/claude-3-7-sonnet` | `-` (or `medium`) |
| **Operator** | Local Git, worktree management, memory | `litellm/gpt-4o-mini` or `litellm/claude-3-5-haiku` | `-` |
| **External** | GitHub CLI (`gh`), MCP, Jira | `litellm/gpt-4o-mini` or `litellm/claude-3-5-haiku` | `-` |
| **Researcher**| Codebase exploration, search | `litellm/gpt-4o` or `litellm/claude-3-7-sonnet` | `-` |
| **Implementer**| Code modifications, unit tests | `litellm/gpt-4o` or `litellm/claude-3-7-sonnet` | `-` |
| **QA** | Runtime verification, smoke tests | `litellm/gpt-4o` or `litellm/claude-3-7-sonnet` | `-` |
| **Planner** | Architecture, task breakdown | `litellm/gpt-4o` or `litellm/claude-3-7-sonnet` | `-` |
| **Reviewer** | Code review, lint, test inspection | `litellm/gpt-4o` or `litellm/claude-3-7-sonnet` | `-` |

### 3. Verifying LiteLLM readiness

Before using the agents, verify the LiteLLM connection without sending expensive test requests:

1. **Verify proxy health**:
   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/health
   ```
2. **Verify model catalog**:
   Open OpenCode and check `/models`, or run the diagnostic tool:
   ```sh
   npm run harness:doctor
   ```
   `harness:doctor` inspects the active provider list and catalog to confirm that `litellm/*` deployments are visible to OpenCode.
3. **Conversational smoke test**:
   Start a new session in OpenCode with **Lead**, verify that the model in the chat UI displays `litellm/...`, and confirm that subagents invoke with their assigned LiteLLM models.


## What is installed and preserved

The selected config receives inline V2 `agents` definitions: description, primary/subagent mode, selected model, role permissions, and the native conversational system prompt. Inline definitions avoid the historical `agent/` versus `agents/` file-layout discrepancy. No harness plugin, host, IPC service, workflow database, or Markdown agent copies are installed.

Existing role collisions are identified in the final summary. Existing description, mode, and system prompt are preserved by default; missing fields receive template values. Unchanged fields attributable to the active receipt refresh from the templates. Customized/unattributed fields have separate keep-default replacement prompts. Other role fields (such as color, steps, hidden/disabled flags, and requests) are preserved. The shared permission planner retains existing rules and their relative order, adds compatible missing template rules, and aborts on ambiguous identities or unsafe restriction overrides. Obsolete owned rules default to keep; each removal requires a separate selection before final confirmation. The preview shows additions, removals, retained obsolete rules, and final order. These preserved fields may affect discovery/behavior. Unrelated agents, providers, credentials, MCP connections, plugins, and other settings are preserved; JSONC comments, trailing commas, BOM, and line endings are retained. Existing `$schema` is preserved, or the published editor-schema URL is added when absent.

### Cumulative v2 recovery receipts

Installer and global integration permission changes extend one validated receipt chain
in the recovery directory. Each immutable v2 receipt carries a unique identity,
predecessor filename/identity/SHA-256 digest, original managed-field baselines, latest
managed values, permission sources and order evidence, and created containers. It
does not own connections, credentials, preferences, or project context. A matching
preexisting permission rule never becomes owned merely by matching a template.

Discovery refuses missing/altered predecessors, duplicate identities, forks/cycles,
pending receipts, or multiple unrelated heads for the same target. Keep the complete
chain together. Receipt bytes and file identities are rechecked after review and
before writes. A pending successor is written before configuration save and finalized
only after the saved configuration is verified. Only finalization supersedes its
predecessor; the predecessor file is not rewritten. Partial saves or finalization
failures retain pending evidence and report its path. Resolve recovery explicitly
before another update; never delete evidence just to bypass a conflict.

Uninstall must select the active head. Superseded receipts cannot be restored
independently. Restore removes uniquely identifiable owned rules while retaining later
user additions, restores original managed fields only when their latest managed state
still matches, and removes only empty installer-created containers. Missing, edited,
duplicated or moved owned rules produce a no-write conflict. User field edits also
conflict rather than being overwritten.

Version 1 installer and adoption receipts remain readable and can become predecessors.
Their permission arrays remain opaque whole-field evidence: no per-rule ownership is
inferred. New v2 additions can be attributed separately, but restoring the legacy array
still requires an exact match after removing those additions. Legacy installations
without native-rule provenance may therefore conflict when setup would override an
unattributed deny. A receipt is local recovery evidence, not a cryptographic trust or
authorization boundary against a same-user process rewriting the entire history.

Automated lifecycle tests cover native install → integration → upgrade → restore.
Independent review and isolated interactive CLI QA remain required before live use.

Existing named Markdown agents in relevant global/project/ancestor `agent` or `agents` directories cause an abort: reconcile those definitions deliberately before rerunning rather than merging competing prompts/permissions silently. Detected historical adapter installations also cause an abort; disable them intentionally, because their tool filter is incompatible with native shell/MCP access. The installer never deletes those files/plugins. Not every arbitrary plugin or runtime override can be detected; inspect effective config afterward.

An existing target is backed up exactly under the visible `$HOME/Projects/advanced-harness-backups/<timestamp-id>/` directory before an atomic replacement. Backups can contain existing secrets: keep them local and out of Git; POSIX backup permissions are restrictive, while Windows follows the user's folder ACLs. Concurrent changes detected during prompting/save cause an abort. Cancellation creates no backup, directories, or config. Symlink/non-regular targets are not replaced.

## After installation

The installer checks the running OpenCode service after saving, rather than reporting a config write as successful setup. It verifies all eight roles, visibility, primary/subagent modes, exact assigned model/variant, active providers, and enabled catalog models/variants. It compares against your chosen assignments so stale configuration or project overrides cannot silently pass. Checks retry briefly because initial API snapshots can precede plugin settlement.

Run the same checks independently, without reinstalling:

```text
npm run harness:doctor
npm run harness:doctor -- --project "C:/Users/you/Projects/android-app"
npm run harness:doctor -- --opencode "C:/path/to/opencode-cli.exe"
npm run harness:doctor -- --server "http://localhost:49374"
```

Use the same project and server as your OpenCode UI. Global installations are checked in the current directory, including project overrides. The diagnostic lists inspected config paths, not contents or credentials. It uses OpenCode's CLI connection/authentication flow, may start the service, and never reloads/restarts it, edits configuration, substitutes models, or sends inference requests. `OPENCODE_BIN` or `--opencode` selects a CLI; Windows automatically discovers the standard desktop-bundled CLI, otherwise `opencode` on PATH is used. The installer also accepts `--opencode`.

Exit codes: **0** means discovery/catalog checks passed; **1** means definite readiness failures; **2** means verification is inconclusive (CLI, API, timeout, unsupported response, or config/project errors). If verification fails after installation, the saved config and backup remain in place; no automatic rollback or repeated installation is needed.

**Catalog availability does not prove account entitlement.** A listed Spark model can still be rejected by the active ChatGPT account. A real, explicitly approved model run remains necessary before claiming all roles are runnable. MCP, Android tools, and workflow approval behavior are not checked here.

For missing shell/tool claims, see [native tool troubleshooting](tool-troubleshooting.md).
Code Mode searches do not enumerate all native tools. Require invocation/error or
captured offered-tool evidence; without it, availability remains unverified. Source
prompt changes are not automatically deployed: applying them requires separate
consent while preserving installed models, permissions, and unrelated settings.
Deploy prompt-only updates safely using:

```text
npm run harness:deploy-prompts -- [--scope project|global] [--project <directory>] [--config <file>]
```

This refreshes native role descriptions and system prompts from `agents/*.md` into
the target configuration while preserving configured models, reasoning variants,
permission arrays, and unrelated fields, backed by pre-save backups and receipt lineage.


## Safe harness update workflow

To check for newer harness versions and preview updates to installed agent prompts and permissions:

```text
npm run harness:update
npm run harness:update -- --project "path/to/android-project"
npm run harness:update -- --check-remote
```

1. **Discovery**: Compares the local harness checkout (`package.json` version and git commit) against the installed version stamp recorded in the active receipt. If `--check-remote` is specified (or approved at the prompt), it runs a read-only `git ls-remote` to check `origin/main`.
2. **Report/Preview-only**: The update command never runs `git pull` or modifies the harness git checkout. If a newer remote commit is detected, it prints the exact git commands for you to review and run manually.
3. **Per-role inspection and opt-in**: Shows a unified diff for each role where source template prompts have changed. Models, permissions, and custom fields are flagged as preserved. Prompt updates are strictly opt-in per role (default Enter keeps installed prompt).
4. **Safe recovery**: Updates write an exact private backup and a pending successor receipt first. On failure, pending evidence is retained. You can restore through the existing receipt chain (`npm run harness:uninstall`) to rollback cleanly.
5. **Confirmation**: Final confirmation requires typing `update`. Cancellation leaves all files and receipts unchanged.

Install stamps each new receipt with the harness version (`package.json` version and git commit), and the install prints it as `Harness version: ...` before confirmation. Later receipts from integrations, permission setup and prompt deployment carry that stamp forward, so `harness:update` can report the installed version.

If update planning finds any permission reconciliation conflict, the update stops
before role, command-replacement, or final-confirmation prompts. It reports the
configuration path and each conflict's role, code, and message, then returns status
2. Review and resolve the permissions deliberately before rerunning. The blocked
path does not write configuration, commands, backups, receipts, or run verification.

### If Lead is missing

- Look for **Lead**, not an agent named “Harness.” Only Lead is primary; the seven others are subagents.
- Start a **new session**. Existing sessions keep their selected agent and model even when `default_agent` changes.
- If a role is absent from config, check the install target/scope; project installs do not apply to unrelated projects.
- If hidden or disabled, review those preserved settings deliberately; reinstalling does not silently remove them.
- If config and runtime differ, inspect overrides and check the UI is connected to the same service/project. If a service restart is needed, finish active work first and run `opencode service restart` deliberately; diagnostics do not interrupt active sessions.
- If an assigned model/provider/variant fails, connect/enable it or approve a supported replacement explicitly. Never fall back silently.

1. Run `harness:doctor` in the intended project and resolve failed/inconclusive checks.
2. Start a new Lead session; verify its model and reasoning variant and every child role's model access. No entitlement validation is implied by installation.
3. Confirm actual MCP server aliases/tool actions. External's source permissions use `jira_*`, `github_*`, `figma_*`, and `stitch_*`; adapt them to configured names. The installer preserves MCP configuration, does not authenticate services, and does not change permission patterns to guess server capabilities.
4. Agree project/worktree/memory paths and build/test/device/E2E commands.
5. Pilot plan approval in the Lead conversation, implementation, review/QA, finding decisions, final approval, and publishing. OpenCode permission prompts remain tool authorization, not plan approval.

To undo an installation, inspect the saved backup and merge/restore intentionally; do not discard configuration changes made after installation. New configs have no preexisting backup. Automated tests cover parsing, model selection, preservation, conflict detection, backup/concurrency behavior, and refusal of noninteractive installation—not a real-account Android pilot.

An isolated configuration inspection with bundled OpenCode 2.0.25 accepted the generated inline definitions for all eight roles and normalized the selected synthetic model references. This checked config loading, not runnable model entitlements or effective agent discovery: the synthetic provider was not an authenticated real account. No user/global configuration or credentials were changed by that check.

On 2026-10-09, the diagnostic passed discovery/catalog checks against the user's installed global configuration and bundled OpenCode 2.0.26: Lead and all seven subagents were visible with the selected modes and model variants. This did not alter the installation, restart the service, or send model requests, and does not establish why a previous UI session lacked Lead.

The live failure-path test also passed on 2.0.26: a disposable project hid Lead, disabled Operator, and assigned an unavailable provider/model. The diagnostic correctly failed each condition. Its project config was removed afterward; the global installation was unchanged.

### Optional live regression check

Unit tests use injected API snapshots and do not start OpenCode. The live test is skipped unless `HARNESS_LIVE_OPENCODE` names your CLI executable. It uses your existing service/connection, may start the service, creates and removes only its own disposable project under `$HOME/Projects`, and makes no inference requests:

```powershell
$env:HARNESS_LIVE_OPENCODE = 'C:/path/to/opencode-cli.exe'
node --test test/native-diagnostics-live.test.ts
Remove-Item Env:HARNESS_LIVE_OPENCODE
```
# Receipt-backed uninstall

`npm run harness:uninstall -- --config <opencode.json|opencode.jsonc> --receipt <receipt>`
offers an interactive, receipt-backed restoration preview. For an installation without
a harness receipt, `--adopt-existing --before-config <known-before-config>` offers
bulk adoption or one decision per detected agent, with root defaults handled separately.
Adoption records the selected baseline as provenance only and does not write the live
configuration. Keep recovery receipts private and use disposable configs when testing.
This workflow remains under BH-021 validation; do not use it for live cleanup until
the documented acceptance and isolated QA are complete.
