# Interactive native-agent installer

Run from the Advanced Harness checkout with Node.js 24. The installer CLI is [`scripts/install-native-harness.ts`](../scripts/install-native-harness.ts):

```text
npm ci
npm run harness:install
```

The installer asks for project or global scope, reads existing `opencode.json`/`opencode.jsonc` files, and asks for a model and reasoning variant for **each of the eight agents**. Nothing is written until you review the assignments and type `install`. Enter at a model prompt explicitly accepts its displayed suggestion; there is no automatic substitution on model-access failure.

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

Existing role collisions are identified in the final summary. Confirmation replaces those five owned fields while preserving other role fields (such as color, steps, hidden/disabled flags, and requests). Those preserved fields may affect discovery/behavior and need review. Unrelated agents, providers, credentials, MCP connections, plugins, and other settings are preserved; JSONC comments, trailing commas, BOM, and line endings are retained. Existing `$schema` is preserved, or the published editor-schema URL is added when absent.

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
