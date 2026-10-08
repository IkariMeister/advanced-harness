# Interactive native-agent installer

Run from the Advanced Harness checkout with Node.js 24:

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

1. Inspect effective config and agent discovery with OpenCode's diagnostic commands on your installed version.
2. Start a new Lead session; verify its model and reasoning variant and every child role's model access. No entitlement validation is implied by installation.
3. Confirm actual MCP server aliases/tool actions. External's source permissions use `jira_*`, `github_*`, `figma_*`, and `stitch_*`; adapt them to configured names. The installer preserves MCP configuration, does not authenticate services, and does not change permission patterns to guess server capabilities.
4. Agree project/worktree/memory paths and build/test/device/E2E commands.
5. Pilot plan approval in the Lead conversation, implementation, review/QA, finding decisions, final approval, and publishing. OpenCode permission prompts remain tool authorization, not plan approval.

To undo an installation, inspect the saved backup and merge/restore intentionally; do not discard configuration changes made after installation. New configs have no preexisting backup. Automated tests cover parsing, model selection, preservation, conflict detection, backup/concurrency behavior, and refusal of noninteractive installation—not a real-account Android pilot.

An isolated configuration inspection with bundled OpenCode 2.0.25 accepted the generated inline definitions for all eight roles and normalized the selected synthetic model references. This checked config loading, not runnable model entitlements or effective agent discovery: the synthetic provider was not an authenticated real account. No user/global configuration or credentials were changed by that check.
