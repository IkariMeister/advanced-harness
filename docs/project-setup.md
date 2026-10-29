# Project setup

From the Advanced Harness checkout with Node.js 24:

```powershell
Set-Location "$HOME/Documents/Advanced Harness"
npm run harness:setup -- --global
npm run harness:setup -- --project "C:/path/to/project-checkout"
```

Or run `npm run harness:setup` and select scope interactively (`global` or `project`). Leading `~` and `$HOME` are expanded in prompted paths. Setup supports any Git checkout/worktree root as well as non-Git project directories. Android Gradle build/settings files and `package.json` scripts are detected heuristically for check suggestions, but neither is required. Git worktree `.git` files are supported. Use `--help` for invocation details. Piped input is refused.

Project settings are stored **only in project context**: `AGENTS.md` by default, or a Markdown file selected with `--context docs/HARNESS.md`. An alternate file receives an explicit reference from `AGENTS.md`. In global scope, defaults are saved to `~/.config/opencode/harness.project.json`. There is no required machine-local JSON profile in the project checkout.

## What setup asks

- **Setup scope**: `global` or `project` (defaults to `global` when running interactively without arguments).
- **Base branch**: explicitly confirm the repository's base (for example `main` or `develop`). The suggested name is not a Git-verified branch.
- **Command shell**: `powershell`, `bash`, or `cmd`. This selects suggested syntax only; it does not select/validate the actual execution shell, check readiness, or convert commands already entered/saved. Expected wrappers are `./gradlew` for Bash, ` .\gradlew.bat` for PowerShell, and `gradlew.bat` for cmd. Confirm that the execution environment matches. Windows defaults to PowerShell; macOS defaults to Bash-compatible syntax.
- **Build, lint, unit, Roborazzi, runtime, and E2E commands**: each is a single shell command line, run later from the active application worktree root. Enter accepts the suggestion; `-` leaves that check **unconfigured**. Existing unconfigured checks remain unconfigured on repeat setup unless you change them. Non-Android projects automatically omit `roborazzi` and leave it unconfigured.
- **Additional project gates**: optional extra required checks, such as `spotless` or `detekt`, each with a lowercase name and a single command line. They are saved as `additionalChecks` and run by Reviewer alongside the standard checks; they never replace `lint`. Gates detected in Gradle files are offered first (Enter accepts, `-` leaves them out); then enter more names, or press Enter to finish. On repeat setup, saved gates are reconfirmed (`-` removes one) and a detected gate you left out earlier is offered with `-` as the default, so it is not silently re-enabled.
- **Device preference**: for Android/Gradle projects, `physical-first` (default), `emulator`, or `ask`, plus an optional serial. This records a preference, not a device connection/validation. `-` removes the serial so QA can select at runtime. Non-Android projects default device preference to `ask` without prompting.
- **Worktree parent**: defaults to `$HOME/Projects/advanced-harness-worktrees/<project-id>`.
- **Shared memory**: defaults to `$HOME/Projects/advanced-harness-data/<project-id>/MEMORY.md`. The ID includes a short canonical-path hash to avoid collisions between different checkouts with the same name. Clones intended to share memory can explicitly select the same agreed path.

Worktree and memory paths must be outside the app checkout, must not contain it, and shared memory must not sit within the worktree parent. These are the defined shared locations: every host reads `worktreeDirectory` and `memoryPath` from the saved settings rather than searching the workspace. On `save`, setup also creates whatever is missing: the worktree parent directory, the memory directory, and a header-only `MEMORY.md`. Each appears in the preview first. An existing `MEMORY.md` is never overwritten, and cancelling creates nothing. Setup creates no Git worktrees, branches, devices, or other operational directories. Task bootstrap later creates the feature worktree under the parent without blocking on existing worktrees unless target branch or worktree names collide.

### Shared locations during `harness:update`

Project-scope `harness:update` settles shared locations once, before any host update. With saved settings, it asks you to confirm both paths (Enter keeps each) and offers to create any missing location. If AGENTS.md has a harness project section without saved paths, such as an older instructions-only section or a legacy `.opencode/harness.project.json`, it asks for both paths with default suggestions. It uses the legacy file's paths as suggestions only after you type `migrate`, and never edits or deletes that file. The chosen paths are saved in an interim `paths` section of the same context file; a later `harness:setup` uses them as suggestions and replaces that section with the full project section. Changes are previewed, and only `paths` applies them; Enter skips this step without blocking the host update. Projects with no harness settings are told to run `harness:setup` instead of being prompted.

## Project inspection and suggestions

Setup reads bounded root/module `build.gradle(.kts)` and `settings.gradle(.kts)` files and root `AGENTS.md`. It skips symlink entries and generated/hidden/source directories; inspection is limited to 2,000 entries and three nested directory levels. Text files over 1 MiB are refused. Textual inspection may miss modules declared through aliases or convention plugins, deeper trees, or beyond scan limits. It does **not** execute Gradle scripts, Git, shell commands, device commands, or private E2E tooling.

Literal Android plugin IDs and Roborazzi references produce heuristic suggestions, such as `./gradlew :app:assembleDebug` or ` .\gradlew.bat :app:testDebugUnitTest`. The first detected module is used, or root-conventional tasks if none was detected. Only an existing wrapper for the selected shell enables suggestions; a wrapper for another shell does not. Enter the correct commands manually or `-` to leave unconfigured. Aliases/convention plugins, deeper modules, flavors, and custom tasks may not be detected correctly. Roborazzi references do not verify that a corresponding task exists. Literal `spotless` or `detekt` references suggest root `spotlessCheck` or `detekt` tasks; these are equally unverified. **Every suggestion needs your confirmation; none is a verified task or result.** Runtime and private E2E commands have no invented defaults. Ask the project owner for the E2E invocation contract.

Commands can perform arbitrary operations when executed later. Do not enter literal secrets; use environment references. Saved commands are configuration, not approval to execute them, and do not automatically expand role shell permissions.

## Files and confirmation

Setup previews choices, destination files, and the proposed marked instructions section. Type `save` or the legacy `setup` to save (surrounding whitespace is ignored). Enter, `cancel`, and every other response cancel; cancellation explicitly reports that nothing changed. It creates no writes or backups:

1. **`AGENTS.md`** by default: adds/replaces only the section between `<!-- advanced-harness:project:start -->` and `<!-- advanced-harness:project:end -->`. It contains the actual settings as fenced JSON and accompanying workflow instructions. Content outside the section is preserved, including BOM and line endings. Malformed/duplicate markers, invalid embedded JSON/settings, and unknown data fields are rejected rather than discarded.
2. **An explicitly selected Markdown context file**, when `--context` is supplied: stores that same marked section, and adds a reference to the file in `AGENTS.md`. The path must stay inside the project. Both files are listed before confirmation.

Setup does not interpret existing instructions: read them and resolve conflicts before confirmation. Existing `.opencode/harness.project.json` files are never edited/deleted. If no embedded project settings exist, setup offers to load a legacy profile as suggestions only after you explicitly type `migrate`. Final `setup` confirmation still previews and approves the context changes. Invalid legacy data can be left untouched by declining migration.

Existing targets receive exact private backups under `$HOME/Projects/advanced-harness-backups` before per-file atomic replacement. Backups may contain existing secrets; keep them private. All targets are checked for concurrent changes before the first write, then rechecked individually. Symlink/non-regular targets and symlinked parent directories are refused. A rare error after the first write can leave partial setup: the error reports completed writes and backups; inspect those files rather than rolling back newer user work blindly. This is not a multi-file transaction.

Cancellation changes no files/directories. Setup preserves OpenCode config, models, MCP, `.gitignore`, app sources, and all instructions outside the selected section.

## Git and worktrees

Context may contain machine-specific paths. **Review before publishing**; setup does not stage, commit, push, or add ignore rules. Use environment-based instructions or deliberate per-machine adjustments where portability is needed. Never put credentials in project context.

Reviewed context files follow ordinary Git/worktree behavior. Untracked context changes do not automatically appear in another worktree; confirm availability through Operator rather than guessing settings. Run commands in the active feature worktree, not the canonical checkout merely because it appears in context. Shared memory remains at the agreed external location.

## After setup

1. Check the actual project: `npm run harness:doctor -- --project "C:/path/to/android-checkout"` from the harness checkout.
2. Start Lead in the app and ask it to read `AGENTS.md` and any referenced context files.
3. Resolve unconfigured commands and confirm tools/device prerequisites. Missing checks are **not** automatically waived, passed, or converted into optional evidence.
4. Approve a small validation plan: Reviewer runs configured build/lint/unit/Roborazzi checks and any additional gates; QA validates runtime/device/E2E where configured. Setup proves no command works.
5. Configure reusable optional integrations globally, then record this project's selected integrations/identifiers in context. An integration is needed only when the task requires it; `none` is not a setup blocker. See [global connections and project context](configuration.md).

Screenshots, videos, logcat, and evidence publication remain optional unless required. Setup is not implementation/publishing approval, permission expansion, or a separate approval host.
