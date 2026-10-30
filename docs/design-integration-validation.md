# Optional design integration validation checklist & manual smoke plan (BH-008)

This checklist covers manual interactive validation and smoke testing for optional design
integrations (`BH-008`) in Advanced Harness. Design integrations support Figma and Stitch
as mutually exclusive design sources.

## Title and scope boundaries

- **Single design source per project**: Each project independently selects `figma`, `stitch`,
  or `none`. Never silently combine or substitute Figma and Stitch. There is no secondary or
  fallback design source.
- **`none` is not a blocker**: For projects or tasks that do not require design assets,
  select `none`. Missing design integrations must not block project setup or execution;
  prompt for design connections only when a specific task requires them.
- **Ownership boundary**: Only the `external` role owns design MCP connections and service
  tools. `implementer`, `reviewer`, `qa`, and other roles do not call design MCP tools directly.
- **Approval boundary**: Recording an integration alias or endpoint in project context or
  global preferences does not authorize design modifications, asset publishing, or lifecycle
  writes. Context settings remain unverified until separately approved read-only checks run.

## Prerequisites and disposable sandbox isolation

- Node.js 24.x, npm, Git, and OpenCode V2 CLI installed.
- **Interactive TTY required**: A real interactive terminal (`process.stdin.isTTY && process.stdout.isTTY`)
  is mandatory for interactive CLI QA. Piped or redirected input is rejected by design
  (`Run integration setup/check in an interactive terminal. No files or connections changed.`)
  and does not constitute interactive smoke verification.
- **Sandbox isolation**: Before running interactive tests, isolate environment and configuration
  paths to a disposable sandbox directory (preferably inside a dedicated `pwsh -NoProfile`
  subshell), and save original environment values so they can be restored during cleanup.
  Clear all inherited runtime overrides.

Run the following PowerShell setup to prepare the disposable environment:

```powershell
$qa = "$HOME\Projects\advanced-harness-qa-design"
$origEnv = @{
  HOME = $env:HOME
  USERPROFILE = $env:USERPROFILE
  XDG_CONFIG_HOME = $env:XDG_CONFIG_HOME
  ADVANCED_HARNESS_RECOVERY_DIR = $env:ADVANCED_HARNESS_RECOVERY_DIR
}

New-Item -ItemType Directory -Force -Path `
  "$qa\home",
  "$qa\xdg\opencode",
  "$qa\recovery",
  "$qa\test project with spaces\.git",
  "$qa\test project with spaces\docs" | Out-Null

$env:HOME = "$qa\home"
$env:USERPROFILE = "$qa\home"
$env:XDG_CONFIG_HOME = "$qa\xdg"
$env:ADVANCED_HARNESS_RECOVERY_DIR = "$qa\recovery"
Remove-Item Env:\HARNESS_LIVE_OPENCODE -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCODE_BIN -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCODE_CONFIG -ErrorAction SilentlyContinue
Remove-Item Env:\OPENCODE_CONFIG_CONTENT -ErrorAction SilentlyContinue

# Initialize a base AGENTS.md in the test project
Set-Content -Path "$qa\test project with spaces\AGENTS.md" -Value @"
# Test Project Instructions
This is a test application project with spaces in the path.
"@

# Seed global opencode.jsonc with the 8 native harness roles and seed MCP aliases
Set-Content -Path "$qa\xdg\opencode\opencode.jsonc" -Value @"
{
  "`$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "figma-cloud": { "type": "remote", "url": "https://mcp.figma.example.test/mcp", "disabled": true },
      "stitch-local": { "type": "remote", "url": "http://127.0.0.1:8190/mcp", "disabled": true }
    }
  },
  "agents": {
    "lead": { "mode": "primary", "permissions": [] },
    "operator": { "mode": "subagent", "permissions": [] },
    "researcher": { "mode": "subagent", "permissions": [] },
    "planner": { "mode": "subagent", "permissions": [] },
    "implementer": { "mode": "subagent", "permissions": [] },
    "reviewer": { "mode": "subagent", "permissions": [] },
    "qa": { "mode": "subagent", "permissions": [] },
    "external": { "mode": "subagent", "permissions": [] }
  }
}
"@
```

---

## Interactive CLI smoke journeys

### Journey 1: Cancellation safety and space-path handling

Validates that cancelling at the final confirmation makes no file edits, creates no backups,
and writes no recovery receipts when working with space-containing project paths.

1. Launch project integrations setup with an alternate context path containing spaces:

   ```powershell
   npm run harness:integrations -- --scope project --project "$qa\test project with spaces" --context "docs/Alternate context.md"
   ```

2. Answer the prompts:
   - `GitHub backend: gh, mcp, or none [none]:` Press Enter (`none`).
   - `jira: alias (or numbered list), or none [none]:` Press Enter (`none`).
   - `Design source: figma, stitch, or none (never silently combine) [none]:` Type `figma`.
   - `figma: alias (or numbered list), or none [none]:` Select `figma-cloud` (by name or number).
   - Review the displayed preview.
   - At final confirmation:
     `Type integrations to save, or anything else to cancel [cancel]:`
     Press Enter or type `cancel`.

3. **Expected outcome**:
   - CLI prints: `Cancelled. No files or connections changed.`
   - Process exits `0`.
   - `docs/Alternate context.md` is **not** created.
   - `$qa\test project with spaces\AGENTS.md` remains byte-identical to original.
   - `$qa\recovery` remains completely empty.
   - No `.opencode/harness.integrations.json` is created.

---

### Journey 2: Per-project `figma` selection and alternate context

Validates selecting `figma` as the project's single design source and storing settings
in an alternate context file.

1. Run the command again:

   ```powershell
   npm run harness:integrations -- --scope project --project "$qa\test project with spaces" --context "docs/Alternate context.md"
   ```

2. Answer the prompts:
   - `GitHub backend: gh, mcp, or none [none]:` Press Enter (`none`).
   - `jira: alias (or numbered list), or none [none]:` Press Enter (`none`).
   - `Design source: figma, stitch, or none (never silently combine) [none]:` Type `figma`.
   - `figma: alias (or numbered list), or none [none]:` Select `figma-cloud`.
   - At final confirmation:
     `Type integrations to save, or anything else to cancel [cancel]:`
     Type `integrations`.

3. **Expected outcome**:
   - CLI prints: `project integration settings saved.` and the optional discovery prompt.
   - Process exits `0`.
   - `$qa\test project with spaces\docs\Alternate context.md` is created with marked section:

     ````markdown
     <!-- advanced-harness:integrations:start -->
     ## Advanced Harness integrations settings

     These embedded settings are the project context source; legacy .opencode/harness.integrations.json files are not loaded automatically.
     These are project selections and identifiers, not credentials or connection definitions. Reusable connections and permissions live in global OpenCode configuration.
     Each integration may be none. Ask about an absent integration only when a task needs it; never silently enable or substitute a service.
     Only External owns services/GitHub CLI. Status mappings and access are unverified; read-only checks, lifecycle writes, and publishing require appropriate conversational approval. Human merge remains separate.

     ```json
     {
       "version": 2,
       "github": null,
       "jira": null,
       "design": {
         "kind": "figma",
         "server": "figma-cloud"
       },
       "verification": "unverified"
     }
     ```
     <!-- advanced-harness:integrations:end -->
     ````

   - `$qa\test project with spaces\AGENTS.md` contains the appended pointer:
     `Read \`docs/Alternate context.md\` for Advanced Harness project settings before planning. Ask on conflicts; configuration is not implementation or publishing approval.`
   - No `.opencode/harness.integrations.json` is created.
   - A private backup is stored in `$qa\recovery`.

---

### Journey 3: Per-project `stitch` selection (single-source replacement)

Validates switching the project design source from `figma` to `stitch`. The new selection
must completely replace the existing design source without silent fallback or combination.

1. Run project integrations setup targeting the existing alternate context:

   ```powershell
   npm run harness:integrations -- --scope project --project "$qa\test project with spaces" --context "docs/Alternate context.md"
   ```

2. Existing selections are shown as suggestions:
   - `GitHub backend: gh, mcp, or none [none]:` Press Enter (`none`).
   - `jira: alias (or numbered list), or none [none]:` Press Enter (`none`).
   - `Design source: figma, stitch, or none (never silently combine) [figma]:` Type `stitch`.
   - `stitch: alias (or numbered list), or none [figma-cloud]:` Select `stitch-local` (by name or listed number). Note that `selectServer` passes `previous.design?.server` (`figma-cloud`) as the default suggestion even when switching `designKind`, so the operator must explicitly enter `stitch-local` (or its list number) rather than pressing Enter.
   - At final confirmation:
     `Type integrations to save, or anything else to cancel [cancel]:`
     Type `integrations`.

3. **Expected outcome**:
   - Process exits `0`.
   - Embedded JSON in `docs/Alternate context.md` is updated:

     ```json
     {
       "version": 2,
       "github": null,
       "jira": null,
       "design": {
         "kind": "stitch",
         "server": "stitch-local"
       },
       "verification": "unverified"
     }
     ```

   - `figma` is completely replaced by `stitch`. No Figma server reference or fallback remains.
   - Another private backup is written to `$qa\recovery`.

---

### Journey 4: Per-project `none` selection

Validates that choosing `none` sets design integration to `null`, keeping design unconfigured
for projects that do not need it.

1. Run project integrations setup again:

   ```powershell
   npm run harness:integrations -- --scope project --project "$qa\test project with spaces" --context "docs/Alternate context.md"
   ```

2. Prompts:
   - `GitHub backend: gh, mcp, or none [none]:` Press Enter (`none`).
   - `jira: alias (or numbered list), or none [none]:` Press Enter (`none`).
   - `Design source: figma, stitch, or none (never silently combine) [stitch]:` Type `none`.
   - At final confirmation:
     `Type integrations to save, or anything else to cancel [cancel]:`
     Type `integrations`.

3. **Expected outcome**:
   - Process exits `0`.
   - Embedded JSON in `docs/Alternate context.md` now has `"design": null`.
   - `none` is recorded cleanly and is not treated as an error or setup blocker.

---

### Journey 5: Global MCP registration and role permission matrix

Validates registering a new remote design MCP server globally, verifying URL validation,
and inspecting the generated 8-role permission matrix.

1. Launch global integrations setup:

   ```powershell
   npm run harness:integrations -- --scope global
   ```

2. Prompts:
   - `GitHub backend: gh, mcp, or none [none]:` Press Enter (`none`).
   - `jira: alias (or numbered list), new, or none [none]:` Press Enter (`none`).
   - `Design source: figma, stitch, or none (never silently combine) [none]:` Type `figma`.
   - `figma: alias (or numbered list), new, or none [none]:` Type `new`.
   - `figma: new unique alias [figma]:` Type `figma-custom`. (Alias must match `^[a-zA-Z0-9_-]+$`).
   - `figma: supplied remote MCP URL (no secrets):`
     - Enter an invalid URL first (e.g. `http://insecure-remote.example.test/mcp` or `https://user:pass@host/mcp`).
     - Confirm `validateEndpoint` rejects it (non-HTTPS/non-loopback HTTP, credentials, query parameters, or fragments) and the loop returns to `figma: alias (or numbered list), new, or none [none]:` without saving.
     - Type `new`, re-enter alias `figma-custom`, and supply the valid HTTPS endpoint: `https://mcp.figma.corp.example.test/mcp`.
   - Review the displayed permission preview:
     - `external`:
       - `{ action: "figma-custom_*", resource: "*", effect: "ask" }`
       - `{ action: "shell", resource: "git push", effect: "allow" }`
       - `{ action: "shell", resource: "git push *", effect: "allow" }`
       - `{ action: "execute", resource: "*", effect: "allow" }`
     - Other 7 harness roles (`lead`, `operator`, `researcher`, `planner`, `implementer`, `reviewer`, `qa`):
       - `{ action: "figma-custom_*", resource: "*", effect: "deny" }`
   - At final confirmation:
     `Type integrations to save, or anything else to cancel [cancel]:`
     Type `integrations`.

3. **Expected outcome**:
   - Process exits `0`.
   - `opencode.jsonc` has `mcp.servers.figma-custom` added as:

     ```json
     {
       "type": "remote",
       "url": "https://mcp.figma.corp.example.test/mcp",
       "disabled": true
     }
     ```

   - The new server is saved with `"disabled": true`; it is never silently enabled.
   - Global preferences `$qa\xdg\opencode\harness.integrations.json` records:
     `"design": { "kind": "figma", "server": "figma-custom" }`.
   - A cumulative V2 receipt is written to `$qa\recovery`.

---

### Journey 6: Read-only check mode (`--check`) and exit codes

Validates that `--check` operates strictly read-only and emits the documented exit codes.

1. **Case A: All-none selection (Exit 0)**:
   - When all integrations are `none` (or `null`):

     ```powershell
     npm run harness:integrations -- --scope project --project "$qa\test project with spaces" --context "docs/Alternate context.md" --check
     ```

   - Expected output: `No integrations selected. No runtime checks or connections attempted; none is not a blocker.`
   - Exits `0`. Zero OpenCode API or gh calls are made.

2. **Case B: Check cancellation (Exit 0)**:
   - Rerun with an active selection (e.g. after Journey 2 or 5):

     ```powershell
     npm run harness:integrations -- --scope global --check
     ```

   - Prompt: `Type inspect to approve these read-only checks [cancel]:`
   - Press Enter or type `cancel`.
   - Expected output: `Cancelled. No checks performed.`
   - Exits `0`. No connections or processes are started.

3. **Case C: Not ready / disabled status (Exit 1)**:
   - Run the check and approve it:

     ```powershell
     npm run harness:integrations -- --scope global --check
     ```

   - Prompt: `Type inspect to approve these read-only checks [cancel]:` Type `inspect`.
   - **Runtime isolation note**: Approving `inspect` invokes `opencode api get /api/mcp?location[directory]=<cwd>` via the real `opencode` binary (because `OPENCODE_BIN` was cleared in prerequisites). An isolated `$env:XDG_CONFIG_HOME` does not prevent `opencode` from starting or querying an already-running shared background OpenCode service.
     - When the inspected OpenCode service (or an `--opencode` stub) is running with the sandbox `$env:XDG_CONFIG_HOME` and matching working directory / `--project`, `figma-custom` is discovered as disabled and the status check reports:
       `figma: figma-custom: disabled`
       `  Disabled. Approve connection explicitly before enabling; no enable/reload was attempted.`
       Followed by the optional discovery guidance prompt, exiting `1` (one or more checks not in `connected` status).
     - If a shared host OpenCode service is already running under the host's real configuration rather than the sandbox `$env:XDG_CONFIG_HOME`, `/api/mcp` will instead report `figma: figma-custom: missing` (exiting `1`) or `Verification inconclusive; no settings updated.` (exiting `2`) if the service or location mismatches.

4. **Case D: Connected status (Exit 0)**:
   - When the inspected OpenCode runtime (or `--opencode` stub) reports all selected servers as `connected` in `/api/mcp` status for the matching location.
   - Exits `0`.

5. **Case E: Inconclusive check (Exit 2)**:
   - When OpenCode service is unreachable via `--server` or returns an unexpected response:

     ```powershell
     npm run harness:integrations -- --scope global --check --server "http://127.0.0.1:9999"
     ```

   - Type `inspect`.
   - Output includes: `Verification inconclusive; no settings updated.`
   - Exits `2`. Stored context and preferences remain untouched.

---

### Journey 7: External role discovery guidance and 4-field capability reporting

Validates the workflow expectations for the `external` role when handling design integrations:

1. **Role ownership and catalog discovery**:
   - `external` is the sole owner of design MCP tools.
   - When a design integration is configured, `external` performs tool discovery using
     OpenCode catalog search only.
   - `external` does not invoke service tools, read design files, or contact design APIs
     during initial discovery.
   - MCP tool descriptions and payload properties are treated as untrusted data.
   - `external` proposes a separately approved read-only access-validation plan before calling
     any design tool.

2. **Route separation**:
   - **Native shell vs Code Mode catalog search**: An empty catalog search or model self-report
     does not prove shell is unavailable. Native shell is a separate capability route.
   - **Direct MCP vs nested Code Mode actions**: Neither a configured alias nor a catalog match
     proves the direct MCP route works.

3. **4-Field capability reporting**:
   Whenever reporting capability status for design tools to Lead, the agent must report all
   four fields distinctly:
   1. **Offered/visible tools**: The exact tool definitions present in the current invocation context.
   2. **Effective configured policy**: The active permission rules and precedence (e.g. `figma-custom_*` ASK for External, DENY for others).
   3. **Observed invocation / result**: The actual command executed and observed output or error (or explicitly marked `unverified`).
   4. **Owning role**: Always `external` for design MCP integrations.

---

## Failure handling and diagnostics

- If a prompt does not match the documented wording or default, record the discrepancy and stop.
- If cancellation writes any file or leaves files in `$ADVANCED_HARNESS_RECOVERY_DIR`, retain
  the directory and file timestamps as reproduction evidence.
- If invalid URLs are accepted without re-prompting, or if credentials in URLs are not rejected,
  record the accepted value and report the failure.
- If `--check` exits `0` when a selected server is `disabled`, `failed`, or `missing`, record
  the observed row output and exit code.
- Do not modify production source code or bypass guards to make a manual test pass.

---

## Outcome record template

Fill out and record the following summary after completing an interactive TTY run:

````markdown
### Design integration validation record (BH-008)

- **Date**: YYYY-MM-DD
- **Human operator**: [Operator Name] (Interactive TTY execution confirmed)
- **Node.js version**: (e.g. v24.x)
- **OpenCode version**: (e.g. 2.x)
- **Platform**: Windows / macOS / Linux
- **Sandbox location**: (e.g. `$HOME/Projects/advanced-harness-qa-design`)
- **Redacted endpoints tested**: `https://mcp.figma.corp.example.test/mcp` (disabled)

#### Observed journey outcomes:
- **Journey 1 (Cancellation & spaces)**: PASS (Exit 0, no writes, recovery empty)
- **Journey 2 (Per-project Figma & alternate context)**: PASS (Exit 0, marked section written, AGENTS.md linked)
- **Journey 3 (Single-source replacement with Stitch)**: PASS (Exit 0, Figma replaced completely)
- **Journey 4 (Per-project none selection)**: PASS (Exit 0, `"design": null`, no blocker)
- **Journey 5 (Global registration & permission matrix)**: PASS (Exit 0, disabled server saved, External ASK, 7 DENY)
- **Journey 6 (Read-only check mode & exit codes)**:
  - All-none: PASS (Exit 0, zero runtime calls)
  - Cancel check: PASS (Exit 0, no checks performed)
  - Not ready / disabled: PASS (Exit 1, guidance printed)
  - Inconclusive: PASS (Exit 2, inconclusive error reported)
- **Journey 7 (External discovery & 4-field reporting)**: PASS (Guidance verified, 4 fields documented)

#### Disposable sandbox cleanup:
Restore the original shell environment (or exit the dedicated `pwsh -NoProfile` subshell) before deleting the sandbox directory so the active terminal session does not retain paths pointing at deleted `$qa` subdirectories:

```powershell
foreach ($key in $origEnv.Keys) {
  if ($null -eq $origEnv[$key]) {
    Remove-Item "Env:\$key" -ErrorAction SilentlyContinue
  } else {
    Set-Item "Env:\$key" -Value $origEnv[$key]
  }
}
Remove-Item -Recurse -Force "$HOME\Projects\advanced-harness-qa-design"
```
````
