# Smoke test plan

Fast, automated end-to-end checks that the real `harness:*` CLIs still work
together on a clean machine. The smoke suite complements `npm test` (unit and
flow tests with injected dependencies) by spawning the actual scripts in
`scripts/` against an isolated sandbox.

```text
npm run smoke
```

The suite runs serially and takes about 20 seconds. It needs Node.js 24.x and Git. It needs no
OpenCode install, model connection, credentials, network access, or `gh` login.

## What the sandbox isolates

Each journey calls `createSandbox()` (`smoke/support/sandbox.ts`), which creates a
throwaway directory under the OS temp folder and runs every script with:

| Isolated | How |
| --- | --- |
| Home and config | `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `APPDATA`, `LOCALAPPDATA` point inside the sandbox |
| Recovery receipts and backups | `ADVANCED_HARNESS_RECOVERY_DIR` points inside the sandbox home |
| Git | `GIT_CONFIG_GLOBAL` is a sandbox file, `GIT_CONFIG_NOSYSTEM=1`, and no prompts |
| Target project | A scratch Git checkout with Gradle files and a pre-existing `AGENTS.md` |
| OpenCode runtime | `OPENCODE_BIN` points to a deterministic stub (below) |

The sandbox is deleted after each suite. Global-scope checks fingerprint protected
paths in the **real** home with streaming SHA-256 and byte size; safe output exposes
only entry names/type/size/digest, never contents or reversible encodings. Symlinks
are identified without following their targets.

### OpenCode stub

`smoke/support/opencode-stub.ts` answers `opencode api [--server <url>] get
/api/{agent,model,provider,mcp}?location[directory]=…`. It reads the installed
OpenCode configuration and reports it back as a healthy catalog, logging every
call to `opencode-calls.jsonl` in the sandbox. Smoke assertions use that log to
prove that only read-only `api get` calls were made, and that none were made
where none are expected.

On Windows, `execFile` cannot launch a `.cmd` shim without a shell. The stub is
therefore a hard link (or copy) of `node.exe` named `opencode.exe`, preloaded
through `NODE_OPTIONS`. On POSIX it is a small shell wrapper.

The stub mirrors the configuration. It proves the CLI wiring and the doctor's
parsing, **not** OpenCode's real discovery, provider access, or model entitlement.

The stub also cannot show whether a host enforces the security guardrails. That is
checked by hand with the [guardrail validation checklist](guardrail-validation.md).

## Interactive prompts: non-TTY evidence only

Every `harness:*` script refuses to run unless stdin and stdout are TTYs. The
smoke runner preloads `smoke/support/tty-preload.mjs` (test-only) to pass that
guard. It then answers each prompt over a pipe, sending each scripted answer only
after the matching prompt line has been printed. A prompt with no scripted
answer fails the journey after 5 seconds.

**This is not interactive CLI QA** (see `AGENTS.md`). It covers prompt order,
default-on-Enter values, cancellation, and the resulting files. It does not
cover terminal rendering, raw-mode key handling, or a human's experience. SMK-OC-01
runs without the preload to confirm the TTY guard itself still rejects piped
input with no writes.

## Journeys and cases

Hosts covered: OpenCode V2, Claude Code, and Google Antigravity, which have
native deployment. OpenAI Codex installation is gated (issue #45); its smoke cases
assert the gate. The host-selection prompt journey is covered by
`smoke/host-selection.smoke.ts`: it re-asks comma-separated and `all` answers,
keeps OpenCode on Enter, and rejects unsupported Cursor without writes. Cursor
otherwise remains compile-only and is covered by `npm test`.

### SMK-OC: OpenCode project lifecycle (`smoke/opencode-lifecycle.smoke.ts`)

| ID | Case | Expected |
| --- | --- | --- |
| SMK-HS-01 | Install host prompt receives comma-separated and `all` answers, then a Claude Code selection | Both invalid multi-host answers are re-asked; Claude Code cancellation leaves project tree and recovery directory unchanged, with no unanswered prompts |
| SMK-HS-02 | Enter at install host prompt | OpenCode remains the default; cancellation leaves project tree and recovery directory unchanged |
| SMK-HS-03 | Update host prompt receives a comma-separated answer, then unsupported Cursor | Multi-host answer is re-asked; Cursor is rejected before writes, with no unanswered prompts |
| OC-01 | Install with piped stdin and no TTY preload | Non-zero exit, guard message, no files or receipts |
| OC-02 | Install preview, Enter at `Type install` | "Cancelled", project tree unchanged, no recovery dir, no runtime calls |
| OC-03 | Install with default model suggestions | 8 inline agents (Lead primary), 6 `.opencode/commands`, 1 receipt, `AGENTS.md` untouched, runtime PASS for 8 roles, only `opencode api get` calls |
| OC-04 | `harness:doctor --host opencode` | Exit 0, 8 PASS lines, no-paid-request disclosure |
| OC-05 | Drift Lead's system prompt, then `harness:deploy-prompts` and type `deploy` | Prompt restored from `agents/lead.md`, model unchanged |
| OC-06 | `harness:update`: cancel, then `update` | Cancel changes nothing; apply succeeds; a rerun no longer reports an unknown installed version |
| OC-07 | `harness:uninstall`: cancel, then `uninstall` | Cancel changes nothing; apply removes all harness agents and commands, keeps a backup, `AGENTS.md` untouched |
| OC-08 | Fresh install receipt has a version stamp | Install exits 0; `harness:update` prints `Installed version: <version> (<commit>)` instead of `unknown` |

### SMK-GL: OpenCode global scope (`smoke/opencode-lifecycle.smoke.ts`)

| ID | Case | Expected |
| --- | --- | --- |
| GL-01 | Global install → global integrations (`gh`, defaults) → doctor → uninstall | Each step exits 0; `harness.integrations.json` records `gh`; real-home harness paths unchanged |

### SMK-CC: Claude Code project lifecycle (`smoke/claude-antigravity.smoke.ts`)

| ID | Case | Expected |
| --- | --- | --- |
| CC-01 | Enter at `Type yes to install` (default `no`) | Exit 1, "No files written", tree unchanged |
| CC-02 | `yes` | `CLAUDE.md` Lead block, `.claude/settings.json` (`agent: lead`, `gh pr merge` denied), 8 agents, 6 commands, `AGENTS.md` untouched, no OpenCode calls; prints `Harness version:` and the install receipt's `harnessVersion.commit` equals `HEAD` |
| CC-03 | `harness:doctor --host claude-code` | Exit 0, `HEALTHY (Installed: Yes)` |
| CC-04 | Receipt-backed uninstall (`--host claude-code --scope project`) | Exit 0; agents, commands, `settings.json`, and `CLAUDE.md` removed; `AGENTS.md` equals its pristine content |

### SMK-AG: Antigravity project lifecycle (`smoke/claude-antigravity.smoke.ts`)

| ID | Case | Expected |
| --- | --- | --- |
| AG-01 | `no` at the confirmation | Exit 1, "No files written", tree unchanged |
| AG-02 | Enter at `Type yes to install` (default `no`) | Exit 1, "No files written", tree unchanged |
| AG-03 | `yes` with unconfigured model preferences | `.agents/` rules, 6 skills, merge-guard script and hook, MCP config; original `AGENTS.md` content preserved; prints `Harness version:` and the install receipt's `harnessVersion.commit` equals `HEAD` |
| AG-04 | `harness:doctor --host antigravity` | Exit 0, `Installed: Yes` |
| AG-05 | Receipt-backed uninstall (`--host antigravity --scope project`) | Exit 0; rules, skills, merge-guard script, `hooks.json`, `mcp_config.json` removed; `AGENTS.md` equals its pristine content |

### SMK-CX: Codex install gate (`smoke/codex-lifecycle.smoke.ts`)

Codex installation is gated because issue #45 requires strict per-role isolation, which Codex does not provide.
The adapter's behavior (install, update, rollback, doctor) is covered by `test/codex-adapter.test.ts`.

| ID | Case | Expected |
| --- | --- | --- |
| CX-01 | `harness:install --host codex` (project) against a fixture with an existing Codex config | Exit 2; stderr names issue #45; project tree byte-identical; no recovery directory |
| CX-02 | `harness:update --host codex` (project) | Exit 2; stderr names issue #45; project tree and recovery directory unchanged |
| CX-03 | Global install and update | Exit 2; sandbox home unchanged; fingerprints of harness-written paths in the real home match before/after; the fingerprint helper is proven against a secret-like fixture and returns hashes only |
| CX-04 | `harness:doctor --host codex` | Doctor stays available: non-zero exit with a Codex message when nothing is installed; nothing is written |

### SMK-PS / SMK-PI: project context (`smoke/project-context.smoke.ts`)

| ID | Case | Expected |
| --- | --- | --- |
| PS-01 | `harness:setup`, Enter at the save preview | "Nothing changed", tree unchanged, no backups |
| PS-02 | Setup with a bash shell, one configured build command, a `detekt` additional gate, emulator, then `save` | Marked section holds the settings JSON with `additionalChecks`; the other checks stay `unconfigured` (lint is not replaced); original `AGENTS.md` text preserved; no legacy profile; an empty worktree parent and a header-only `MEMORY.md` are created, but no Git worktree |
| PI-01 | Project integrations: `gh` plus `example/smoke-android-app`, then `integrations` | Repository recorded; setup section byte-identical; no project OpenCode config; no connection checks |

## Known gaps found by the suite

Gaps are recorded as `todo` tests. They report on every run but do not fail
it. When a gap is fixed, remove the `todo` option so the test becomes a gate.

The previously recorded Claude Code/Antigravity uninstall gap (CC-04, AG-05),
Antigravity confirmation-default gap (AG-02), and install version-stamp gap (OC-08)
are resolved by the host-aware uninstall, #81, and #82 respectively. Codex
receipt-backed uninstall remains unimplemented and explicitly deferred (CX-07);
the Codex gate cases do not assert install or uninstall support.

Codex Windows/macOS TTY validation remains pending; the human waived this manual
test for this pass only. Codex Desktop validation also remains pending and out of
scope. Automated smoke is non-TTY and is not TTY/Desktop runtime evidence.
Multiline config arrays remain deliberately unsupported and fail closed before any
prompt or write; role TOML parse failures are instead preserved unless explicit
overwrite consent is obtained.

The suite also made these observations, which are not asserted:

- Cancelling an OpenCode install exits 0, while cancelling a Claude Code or
  Antigravity install exits 1.
- `harness:integrations --scope global` with `gh` and no global install exits
  with an uncaught stack trace instead of a guided message.

## Out of scope

- Real OpenCode, Claude Code, or Antigravity runtime discovery and model access.
  BH-034 (loopback model fixture) covers that direction.
- `--check` connection checks, `--check-remote`, and anything else that would
  reach GitHub, Jira, MCP servers, or `origin`.
- Interactive TTY QA by a human, the MarsRoverIA pilot, and Android
  build/device commands.

## Continuous integration

The `smoke` job in `.github/workflows/ci.yml` runs `npm run smoke` on
`ubuntu-latest` (the POSIX stub wrapper) and `windows-latest` (the
`opencode.exe` stub). It runs on every push and pull request to `main`. It
needs no secrets or network access beyond `npm ci`. `todo` cases do not fail
the job.
