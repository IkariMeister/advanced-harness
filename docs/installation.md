# Interactive native-agent installer

For macOS-specific manual prerequisites, isolated preparation steps, expected outcomes,
and failure handling, see the [macOS validation checklist](macos-validation.md). It is
preparation only; live service/model validation remains a separate approval.

## Uninstall (BH021)

Installer receipts are stored privately under `$HOME/Projects/advanced-harness-backups` or the isolated `ADVANCED_HARNESS_RECOVERY_DIR`. Receipt-backed uninstall is invoked with `npm run harness:uninstall -- --config <opencode.json|opencode.jsonc> --receipt <receipt>`. For an existing installation, `--adopt-existing` is a separate provenance-only mode; optional `--before-config <known-before-config>` supplies same-path historical evidence. First answer **“Adopt all detected agent fields for removal?”** (default No). Yes selects only present supported fields on the eight known roles for unknown-history removal; one grouped acknowledgment is required. Root `default_agent` and `model` are always prompted separately and default to keep. No asks once per detected agent; keep is the default, and restore requires supplied same-path evidence. Per-agent removal also requires an acknowledgment. Custom agents, other fields, absent fields, and unrelated settings are excluded. An ownership/history warning precedes the grouped choice. A final `adopt` confirmation records provenance only; it changes no config and does not uninstall. A later, separate uninstall preview and `uninstall` confirmation are required. Automated prompt-flow tests compose decisions with adoption/uninstall planning; manual interactive CLI QA remains pending. Do not apply this workflow to a live installation.

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

The installer asks for project or global scope, reads existing `opencode.json`/`opencode.jsonc` files, and asks for a model and reasoning variant for **each of the eight agents**. Existing role model assignments, including expanded model objects and variants, are preserved by default; a separate per-role confirmation is required to replace one. Nothing is written until you review the assignments and type `install`. Enter at a model prompt explicitly accepts its displayed suggestion; there is no automatic substitution on model-access failure.

Examples:

```text
npm run harness:install -- --scope global
npm run harness:install -- --scope project --project "C:/Users/you/Projects/android-app"
npm run harness:install -- --scope project --project "$HOME/Projects/android-app"
npm run harness:install -- --help
```

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
