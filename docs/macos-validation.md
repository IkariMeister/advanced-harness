# macOS preparation and validation checklist

This checklist covers cancellation-only preparation and local checks on macOS; it does
**not** install the harness or complete the LiteLLM/live pilot. Use disposable paths and
an interactive terminal. Do not change a real shared OpenCode configuration.

## Prerequisites and boundaries

- macOS with Node.js 24.x, npm, Git, and OpenCode V2 available. Confirm versions with
  `node --version`, `npm --version`, `git --version`, and `opencode --version`.
- A usable TTY is required for interactive installer/setup prompts. Redirected input is
  not interactive QA.
- Use a disposable project/config and a backup destination such as
  `$HOME/Projects/advanced-harness-backups`; backups can contain secrets and must stay
  private. Never point this procedure at an active/shared installation.
- Isolate the process home, XDG config, and recovery directories before any interactive
  preparation. Clear inherited live-test/runtime/config overrides, including
  `HARNESS_LIVE_OPENCODE`, `OPENCODE_BIN`, `OPENCODE_CONFIG`,
  `OPENCODE_CONFIG_CONTENT`, and `ADVANCED_HARNESS_RECOVERY_DIR`; then set
  `HOME`, `XDG_CONFIG_HOME`, and `ADVANCED_HARNESS_RECOVERY_DIR` to disposable paths.
  Do not assume an isolated config path prevents runtime access: the confirmed install
  flow invokes OpenCode verification after saving.
- This preparation does not enable services, authenticate MCP, contact a model, send
  inference requests, or claim model entitlement. A real live validation needs its own
  explicit plan and approval.

## Local preparation

First isolate environment/configuration paths and clear live/runtime overrides. This
must happen before dependency installation or any test command, so an inherited
`HARNESS_LIVE_OPENCODE` cannot opt in to runtime tests:

```sh
qa="$HOME/Projects/advanced-harness macOS QA"
mkdir -p "$qa/home" "$qa/xdg" "$qa/recovery" "$qa/project with spaces/.git" "$qa/project with spaces/docs"
export HOME="$qa/home" XDG_CONFIG_HOME="$qa/xdg" ADVANCED_HARNESS_RECOVERY_DIR="$qa/recovery"
unset HARNESS_LIVE_OPENCODE OPENCODE_BIN OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT
```

From a clean harness checkout, run only the opt-in-free local checks:

```sh
npm ci
npm run typecheck
npm test
```

Expected: dependency installation succeeds and typecheck/tests complete successfully;
the optional live diagnostic test remains skipped unless explicitly opted in. These
checks do not authenticate or run a model. If a command fails, retain its actual error,
report the failing command, and stop rather than treating a partial run as successful.

Do not run the installer: it invokes OpenCode verification after saving, so an isolated
target does not make its confirmed-install flow runtime-free. Keep installation and
doctor validation for a separately authorized live-validation plan.

```sh
npm run harness:integrations -- --scope project --project "$qa/project with spaces" --context "docs/Alternate context.md"
```

At prompts choose `none` for each service. Select the alternate Markdown context shown
by the command, review the preview, and cancel at final confirmation. Verify both
`AGENTS.md` and the alternate context remain unchanged and the isolated recovery
directory remains empty. This actual integrations flow does not run runtime checks
when `--check` is omitted. Do not run `--check` as part of no-service preparation.

## Interactive behavior to record

- In an interactive Bash session, press Enter at prompts with a displayed default and
  verify the documented default is selected. Enter an invalid value once, then a valid
  value, and confirm the prompt retries. Record which prompt/value was exercised.
- Select an alternate disposable context and verify the displayed destination matches
  it. Cancel at final confirmation and verify no files, preferences, backups, or
  receipts were created/changed. Repeat with paths containing spaces.
- If validating an Android project, run `./gradlew` only when that project's confirmed
  instructions identify the required Gradle command; never guess or execute project
  commands during harness-only preparation.
- Record command, environment prerequisites, observed output/status, and any failure.
  Do not claim interactive behavior was independently reproduced if it was run by
  someone else or no usable TTY was available.

## Diagnostic and failure interpretation

Both `harness:install` (post-save verification) and `harness:doctor` use the OpenCode
CLI/service connection flow; they may start OpenCode. They are **not** part of the
no-runtime local preparation checks above. Run them only under a separately approved
live-validation plan against the intended disposable configuration.
Catalog/discovery success establishes neither account entitlement nor successful
inference. Never set `HARNESS_LIVE_OPENCODE` for this preparation checklist.

If typecheck/tests fail, record the exact command and diagnostic; do not report passing
checks. If config selection, cancellation, path handling, or expected preservation
fails, preserve the disposable fixture and report the observed state. Do not retry
against a real config or work around the failure by changing production code/settings.
Service/authentication or live model failures belong to the separately approved live
pilot, not this preparation result.

## Outcome record

Report the macOS version, Node version, whether a usable TTY was available, exact local
commands and results, configuration scope/destination (without contents/secrets),
whether cancellation and space-containing paths were checked, and unresolved failures.
Keep preparation evidence separate from any later, explicitly approved live validation.
