# Agent E2E suite

The **agent E2E suite** drives a real OpenCode CLI through a set of scripted
**journeys** against a **loopback model fixture**. It checks host plumbing: that
the installed role prompts and permission policy reach OpenCode, that Lead can
delegate to a child role, that a child role's tool calls execute in a sandbox
(`shell` by Operator in pre-`#261` runs; J3 enabled in `#261`, see [Continuous integration](#continuous-integration); live OpenCode / interactive TTY spot-checks remain **waived**, not passed), and that
a violation is reported deterministically. The model's replies are scripted;
tool results are real results produced by OpenCode.

It is separate from the [smoke suite](smoke-test-plan.md), which runs the
`harness:*` scripts with a stub binary. It is run with:

```text
npm run e2e:opencode
```

Unit tests for the harness itself run in `npm test` and never start OpenCode.

## What it proves, and what it does not

It proves:

- the real installer output for OpenCode at project scope (agent `system`,
  `permissions`, `default_agent`, procedure skills, and workflow commands)
  reaches OpenCode 2.3.0 and is applied;
- Lead can call `subagent`, a child role makes its own requests, and Lead
  receives the child's completed report;
- child-role tool calls execute: the scripted `read` (J1) and `shell` (J2, run by
  Operator in a child session) calls ran in pre-`#261` OpenCode 2.3.0 runs, and
  their results are real OpenCode results against the loopback fixture; after `#261`
  enabled J3 (`skill` load + `edit`), the 5-test suite passed in CI (see
  [Continuous integration](#continuous-integration); live OpenCode / interactive TTY
  spot-checks remain **waived**, not passed);
- a violation (an unscripted request, a mismatched expectation, a tool call the
  installed policy does not offer, an unexpected network destination, or a
  credential-shaped header) fails the journey with a precise, repeatable record.

It does **not** prove:

- model quality or behaviour: every model reply is scripted;
- model entitlement, provider access, or that a role used a particular model
  (the fixture attributes requests by the bare model id, which is all it shows);
- that a host enforces the permission policy beyond what the scripted journeys
  observe on this version;
- anything about other OpenCode versions.

## Prerequisites

- **Node.js 24.x** and dependencies installed with `npm ci` from the repository
  root. The suite runs through `npm run e2e:opencode` and uses no other package.
- **OpenCode exactly 2.3.0**, given as an absolute path to the executable in the
  `HARNESS_E2E_OPENCODE` environment variable. The suite never searches `PATH`.
  Any other version, a relative path, or a missing file is an error.
- `HARNESS_E2E_REQUIRE=1` makes a missing or wrong binary a failure instead of a
  skip. Set it in CI and in any run that is meant to count as evidence.
- `HARNESS_E2E_NETNS=1` declares that the run is inside a loopback-only network
  namespace. The suite does not create that namespace. It checks the declaration
  against the live network interfaces before any journey runs. If a non-loopback
  address is present, the suite fails, and no journey counts as passing. Only a
  passing check records `network.enforcement: "netns"`. The check cannot tell a
  network namespace from a host with no active non-loopback interface; the CI job
  creates the namespace, and the suite only checks that no non-loopback address is
  present.
- `HARNESS_E2E_RECORD_DIR` (optional) is an **absolute** directory where a copy of
  each journey record is kept. A relative or empty value is an error. See
  [Journey record](#journey-record).
- Git on `PATH`, for the scratch repository.

Without `HARNESS_E2E_OPENCODE`, every journey is **SKIPPED**. A skip is not a
pass. Skips appear in the test output with the reason.

## How to run

```text
HARNESS_E2E_OPENCODE=/absolute/path/to/opencode HARNESS_E2E_REQUIRE=1 npm run e2e:opencode
```

To keep the records, add `HARNESS_E2E_RECORD_DIR=/absolute/path/to/records`.

The command runs every `e2e/*.e2e.ts` file, which is the journeys file:

- `e2e/opencode-journeys.e2e.ts`: the five journey tests (J1 to J4b), described under
  [The journeys](#the-journeys).

The runner e2e file is not part of this command or the agent-e2e job. It is at
`e2e/eval/runner.e2e.ts` and runs only with `npm run eval:opencode:e2e`. It is opt-in and
run on demand with a real OpenCode 2.3.0 binary. It has three tests: R1 runs the four bound
development scenarios through the evaluation runner, R2 runs a test-only violation, and R3
checks the isolation evidence. It runs six OpenCode runs on Linux (five bound runs and one
violation run) and five on Windows. See [Runner](evaluation.md#runner).

The tests run one after another, each in a fresh sandbox, with no retries.
Each test has a generous timeout. Each OpenCode run has an overall
timeout and an idle timeout (no fixture request for 30 seconds once the first
request has arrived). The journeys file has five tests and runs OpenCode seven times
in total: J1 once, J2 once, J3 once, J4a twice, and J4b twice.

## Isolation

Every journey runs in a sandbox under the OS temporary directory.

| Isolated | How |
| --- | --- |
| Home and config | `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `APPDATA`, `LOCALAPPDATA` point inside the sandbox |
| OpenCode database | `OPENCODE_DB` is a file in the sandbox |
| Git | `GIT_CONFIG_GLOBAL` is a sandbox file, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` |
| Launch directory | `PWD` is the scratch project. OpenCode 2.3.0 boots in the directory named by `PWD`, not the child's working directory, so an inherited `PWD`, `OLDPWD`, or `INIT_CWD` is removed |
| Inherited variables | Removed by a **pattern-based denylist**, not an allowlist, matched case-insensitively. Removed: names containing `SECRET`, `PASSWORD`, `PASSWD`, or `CREDENTIAL`; names ending in `_KEY`, `_TOKEN`, or `_PAT`; `NODE_AUTH_TOKEN`; names starting with `SSH_`, `GH_`, `GITHUB_`, `NPM_CONFIG_`, `AWS_`, `AZURE_`, `GOOGLE_`, `ANTHROPIC_`, `OPENAI_`, `OPENCODE_`, `GIT_`, `XDG_`, `HARNESS_E2E_`, or `npm_`; `NODE_OPTIONS`, `NODE_TEST_CONTEXT`, `HOMEDRIVE`, and `HOMEPATH`; `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` in any letter case; and the launch-directory names above (`PWD`, `OLDPWD`, `INIT_CWD`). Every `GIT_*` variable is removed, including `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, and the author and committer identity variables; the sandbox then sets its own `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, and `GIT_TERMINAL_PROMPT`. A secret whose name matches none of these is **not** removed. `PATH`, `SystemRoot`, `COMSPEC`, `TEMP`, and `TMP` are kept |
| Server | Every run uses `--standalone` (a private server, never the background service). The suite refuses to spawn without `--standalone` or with `--server` |

The scratch project is a Git repository with `README.md` and `notes.md`, each
containing a unique sentinel line, committed as `e2e-sentinel-commit`. The
installed harness is committed as `e2e-harness-install`, so `git status` is clean
before each journey starts.

### What the sandbox does not isolate

On Windows, OpenCode 2.3.0 still lists skills from the real home's skill
directories in the system prompt, even with the home and XDG variables redirected.
It also sets file watchers on the real user-profile directory, the real home's
`.claude\skills` and `.agents\skills` directories, and a Temp path. The journey
record cannot show whether those locations were read. Local Windows runs are
therefore **not hermetic**. The journeys avoid asserting on the available-skills
list or on any system-prompt text beyond role attribution. J3 additionally asserts
that the skill it loads has its base directory inside the sandbox. **CI on Ubuntu
is the authority** for these results.

## Process safety

The human's OpenCode Desktop app and its background processes can run on the same
machine with the same image names. The suite therefore never kills by image name
and never enumerates and kills processes. It terminates only the child PID it
spawned, and that child's descendants by that PID: `taskkill /PID <pid> /T /F` on
Windows, and a SIGKILL to the process group it created on POSIX. Both run without a
shell.

The timeout paths are unit-tested with short `node` children that stand in for
OpenCode. The tests check that an overrunning child is terminated with the
`timed-out` status, that an unrelated `node` process started by the test survives,
and, on Windows, that a grandchild of the child is also gone. The grandchild check
is skipped on POSIX, where a killed grandchild can remain as a zombie and cannot be
told apart from a live process by PID alone.

Inside the sandbox, OpenCode state files may be read to report them, never to find
PIDs to terminate.

## Network

The criterion is that **no outbound call succeeds**. It is not that OpenCode never
attempts one.

- **CI**: the enforcement is a loopback-only network namespace (see
  [Continuous integration](#continuous-integration)). The namespace is what blocks
  outbound connections in CI. The suite checks its claim (`HARNESS_E2E_NETNS=1`,
  every interface address internal) and does not merely declare it. The check
  cannot tell a network namespace from a host with no active non-loopback
  interface; the CI job creates the namespace, and the suite only checks that no
  non-loopback address is present. See [Continuous integration](#continuous-integration)
  for recorded `agent-e2e` CI runs; live OpenCode / interactive TTY spot-checks
  remain **waived**, not passed.
- **Locally**: the suite only detects attempts. It starts a loopback proxy
  recorder and sets `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy`,
  `ALL_PROXY`, and `all_proxy` to it, and sets `NO_PROXY` and `no_proxy` to
  `127.0.0.1,localhost,::1`. Inherited proxy variables are removed first, so the
  child sees only these values. Each connection the recorder accepts is
  classified as a tolerated startup destination or an unexpected one. Nothing
  blocks a client that ignores the proxy.

The namespace guards against accidental egress. It is **not a security boundary**
against a hostile binary, because the runner user has passwordless sudo. The
sha256 pin of the release asset is the protection for the binary's identity.

**Tolerated startup destination.** OpenCode 2.3.0 makes one connection to
`models.opencode.ai:443` on its own at startup (a models catalogue refresh). It
does so on every run: the proxy recorder shows `CONNECT models.opencode.ai:443`,
and stderr shows `Failed to fetch models.dev` with `ECONNRESET`. No off switch was
found. The attempt is therefore tolerated: it is recorded in
`network.toleratedDestinations`, and it is not a violation. The list is the
constant `TOLERATED_STARTUP_DESTINATIONS` in `e2e/support/opencode-sandbox.ts`. It
holds exactly `CONNECT models.opencode.ai:443`, matched on method (exactly), host
(case-insensitively), and port (exactly), with no wildcard or suffix matching. It
is tied to OpenCode 2.3.0, so re-check it on any re-pin.

Any other recorded attempt is an **unexpected destination**. It fails the journey,
and the violation text lists only the unexpected destinations. A plain-HTTP proxy
request, for example `GET http://models.opencode.ai:443/x`, is unexpected: only
the `CONNECT` method is tolerated.

Limits of proxy-based detection: it sees only traffic that honours the proxy
variables. A client that ignores them is not counted locally. The suite also scans
stderr for non-loopback `http(s)` hosts; that scan is a hint for the human, not a
guarantee.

If OpenCode sends its loopback model requests through the proxy despite
`NO_PROXY`, the fixture sees none of them. The recorder then shows a request for
`127.0.0.1`, and the journey fails with a message saying so.

## API keys

No API key is set, and none is sent. The provider block in the scratch project's
`opencode.json` has no `env` entries. The fixture records whether an `Authorization`
header arrived, and whether another credential-shaped header (`X-Api-Key`,
`Api-Key`, or `Cookie`) did. It records only header **names**; a value is never
stored. Every journey fails with a violation if any request, auxiliary title
requests included, carried one of these headers. The record lists the names in
`credentialHeaders`.

## The journeys

Each journey lists the scripted steps for each role and what it asserts. Roles
are the bare model ids (`lead`, `operator`, `implementer`, and so on).

**J1 `lead-reads-repository`**

- Lead: `read {path: "README.md"}`, then `read {path: "notes.md"}`, then a final
  text reply.
- Asserts: the first read result contains the README sentinel; the second contains
  the notes sentinel; the final text expectation sees the notes sentinel; there are
  no role transitions; the handoff count is 0; `git status --porcelain` is empty;
  `HEAD` is unchanged.

**No journey uses `glob` or `grep`.** On OpenCode 2.3.0 both need ripgrep. When
`rg` is neither on `PATH` nor in OpenCode's cache bin directory, OpenCode downloads
ripgrep 15.1.0 from `github.com`. In the first run, a `glob` call returned
`ripgrep execution failed` and caused `CONNECT github.com:443`. The suite avoids
that download, so no journey scripts either tool.

**J2 `lead-delegates-git-to-operator`**

- Lead: `subagent {agent: "operator", ...}`, then an intermediate text reply
  (whose `expect` requires the tool result "working in the background"), then a
  final text reply (whose `expect` requires the latest user message to carry
  `state="completed"`).
- Operator: `shell {command: "git status --porcelain"}`, then
  `shell {command: "git log -1 --format=%s"}`, then a final text reply expecting
  the install commit subject in the tool results.
- Asserts: a denied or rejected shell result (if any) is reported by name; the
  `git status --porcelain` result shows an empty status. The observed result form
  is not pinned, so the check is conservative: the result exists, it is not an
  error or a denial, and it names neither `README.md` nor `notes.md`. The
  transitions include lead to operator and operator to lead; the handoff count is
  1; the second shell result contains `e2e-harness-install`; `git status` and
  `HEAD` are unchanged.

**J3 `implementer-loads-skill-and-edits`**

- Lead: as in J2, delegating to `implementer`.
- Implementer: `skill {id: "harness-procedure-documentation-impact"}`, then
  `edit {path: "notes.md", oldString: <notes sentinel>, newString: <replacement>}`
  (whose `expect` requires the skill body in the tool results), then a final text
  reply.
- Asserts: the `skill` result is present, not denied, and contains the skill
  sentinel; its base directory is inside the sandbox; the first skill invocation
  has `loaded: true` and `skillId: "harness-procedure-documentation-impact"`; the
  outcome is `pass`; transitions include `lead` to `implementer` and `implementer`
  back to `lead`; the handoff count is 1; `notes.md` equals exactly the scripted
  change; `git status --porcelain` lists only `notes.md`; `HEAD` is unchanged;
  `network.unexpectedDestinations` is empty; and `credentialHeaders` is empty.

Earlier, J3 was registered as `todo` and J3a asserted `Permission denied: skill`
because Implementer lacked a `skill.load` allow rule. `#261` adds per-role
`skill.load` allow rules, enables J3, and retires J3a (see
[Continuous integration](#continuous-integration)); live OpenCode / interactive TTY
spot-checks remain **waived**, not passed.

**J4 `violations-fail-deterministically`**

Two cases, each run twice in fresh sandboxes (run 1 and run 2). Each case passes
only if its record has `outcome: "fail"` with exactly the expected violation and
the two serialised records are byte-identical.

- Case a: Lead is scripted to call `shell {command: "git log -1 --format=%s"}`.
  The installed policy does not offer `shell` to Lead. OpenCode 2.3.0 reports this
  to the model as a tool result, `No tool named "shell" is currently available`
  (observed; the run then continued). The next step expects the commit subject, so
  that expectation fails. Expected: exactly one violation, at step 1, whose received
  text contains that message.
- Case b: Lead has one scripted `read`. The next request has no step left. Expected:
  exactly one "unscripted request" violation.

Only the expected violations are counted. The network part of a record never
produces a violation for the tolerated startup destination, so each case has one.

## Journey record

A journey record is written as `journey-record.json` in the sandbox root (outside
the scratch project). When `HARNESS_E2E_RECORD_DIR` is set, the same bytes are also
written to that directory, as described under [Retained records](#retained-records).

Its top-level keys are: `kind` (`harness.opencode-journey-record`), `version` (`1`),
`journey`, `opencodeVersion`, `outcome` (`pass` or `fail`), `violations`,
`requests`, `toolCalls`, `roleTransitions`, `handoffCount`, `skillInvocations`,
`network`, and `credentialHeaders`.

Repeat comparison in the evaluation runner (see [Runner](evaluation.md#runner)) compares normalized evaluation results, not journey records: run IDs, durations, and the run-directory prefix of artifact paths are removed first. That is a different comparison from the byte-identical comparison of two serialised journey records described under [Determinism rules](#determinism-rules).

The record is a suite-level artifact at `version: 1`, not an evaluation result. Issue
#225's evaluation contracts are merged, but they define an evaluation result
(`eval/schemas/result.schema.json`, `src/eval-contracts.ts`), not this record.
The evaluation runner maps the record into an evaluation result for each bound
scenario (see [Runner](evaluation.md#runner)). The same concepts have different
shapes in the two artefacts, and no field is renamed for that mapping:

- the record's `roleTransitions` are `{seq, from, to}` objects, and its
  `skillInvocations` are objects (`{seq, role, skillId, loaded}`);
- the evaluation result's `metrics.roleTransitions` and `metrics.skillsInvoked` are
  arrays of strings (`eval/schemas/result.schema.json`).

- `network` has three keys: `enforcement` (`netns` or `none`),
  `toleratedDestinations`, and `unexpectedDestinations`. Both destination lists
  hold sorted, de-duplicated `METHOD host` strings, with no counts (retries vary
  between runs). For a passing run, a typical record is:

  ```json
  "network": {
    "enforcement": "none",
    "toleratedDestinations": ["CONNECT models.opencode.ai:443"],
    "unexpectedDestinations": []
  }
  ```

  The tolerated list is non-empty on every observed run, because OpenCode 2.3.0
  makes that attempt on every run. Any entry in `unexpectedDestinations` is a
  violation, and the record's `outcome` is `fail`.
- `credentialHeaders` is a sorted, de-duplicated list of lower-case header
  **names** (for example `["authorization"]`) seen on any request. It is empty on a
  clean run. Any entry is a violation. No header value is ever recorded.
- `handoffCount` counts a completed handoff: Lead made a `subagent` call for a
  role, that role then made a request, and a later Lead request carries a user
  message with a `<subagent ... state="completed">` block. Report blocks are
  matched to calls in order. A report with any other `state` counts zero.
- Each entry of `skillInvocations` is one `skill` tool call by a role. Its `loaded`
  field is `true` only when the host confirmed the load, which means the skill's
  tool result contains the sentinel line from its compiled body. A journey asserts
  that a skill was invoked only on `loaded: true`. A denied call is recorded with
  `loaded: false`.
- Auxiliary requests (OpenCode's tool-less title generation) are excluded from the
  requests, transitions, sessions, and handoffs. They are included in the
  credential check.

### Retained records

With `HARNESS_E2E_RECORD_DIR` set to an absolute path, every journey writes its
record there, creating the directory if needed. The file names are deterministic:

| Journey | File |
| --- | --- |
| J1 `lead-reads-repository` | `lead-reads-repository.json` |
| J2 `lead-delegates-git-to-operator` | `lead-delegates-git-to-operator.json` |
| J3 `implementer-loads-skill-and-edits` | `implementer-loads-skill-and-edits.json` |
| J4 case a, run 1 and run 2 | `violations-fail-deterministically-case-a.run1.json`, `.run2.json` |
| J4 case b, run 1 and run 2 | `violations-fail-deterministically-case-b.run1.json`, `.run2.json` |

The bytes are the same serialisation as the copy in the sandbox. A relative or
empty `HARNESS_E2E_RECORD_DIR` is rejected with a clear message, and the suite
does not run. In CI the job keeps the directory as an artifact (see
[Continuous integration](#continuous-integration)).

## Determinism rules

- No timestamps, random values, ports, or raw session ids are written to a record.
  In violation text, the sandbox root becomes `<sandbox>` (with separators in the
  relative part normalised to `/`), applied before the home replacement below. The
  parent's real home directory becomes `<home>` in every string of a record,
  including tool-call arguments and tool results quoted in them, in backslash,
  forward-slash, and JSON-escaped forms (case-insensitive on Windows). Other
  absolute paths that a tool result quotes are not rewritten. No credential value
  is recorded (see [API keys](#api-keys)). Identifiers `ses_`, `prt_`, and `msg_` are numbered
  `ses_1`, `ses_2`, and so on in order of first appearance. Session headers are
  labelled `S1`, `S2`, and so on.
- Violation text is normalised the same way, and the run duration is never
  included.
- Scripts are fixed, so two runs of one failing case produce the same record.
- Failure text printed by the suite replaces the parent process's real home
  directory with `<home>`, so local output does not show it.

## Observed OpenCode 2.3.0 behaviour the suite relies on

These were observed in early observation runs, not as a conformance test:

- Each model request is `POST /v1/chat/completions` with `stream: true` and
  `stream_options.include_usage`. Agent turns offer a `tools` array. No
  `Authorization` header is sent (every journey checks this).
- The model field is the bare model id (for example `lead`), which is how the
  fixture attributes a role.
- Before each main request, OpenCode sends a tool-less title-generation request.
  The fixture answers it without consuming a scripted step.
- The `x-opencode-session` header is the same for a parent request and its child's
  requests, so it cannot separate sessions. The suite does not rely on it for
  attribution.
- The `subagent` tool returns at once with text containing "working in the
  background". The child runs in its own requests. When it finishes, Lead receives a
  new user message with the `<subagent ... state="completed">` block, and
  `opencode run` waits for that before exiting.
- Tool results come back as `tool` messages with the call id. Invalid arguments
  return a JSON error string to the model rather than stopping the run.
- A skill result carries `Base directory for this skill:` followed by the skill's
  directory, when the skill loads.

**Observed in real runs against OpenCode 2.3.0** (with the installed policy; these
are observations against the loopback fixture, not a conformance test; live OpenCode
and interactive TTY spot-checks remain **waived**, not passed):

- In pre-`#261` runs, `read` (J1) and `shell` (J2) executed successfully, and J3a
  observed `Permission denied: skill`. After `#261` added per-role `skill.load`
  allow rules and enabled J3, the 5-test suite passed in CI (see
  [Continuous integration](#continuous-integration)).
- `--auto` approved Operator's `ask` shell rule in the child session (J2): both
  shell calls ran, and the installed agent configuration was in effect for the
  child requests.
- `shell` is not offered to Lead. The tool result is
  `No tool named "shell" is currently available` (J4a).
- `glob` returned a `ripgrep execution failed` error and caused a download from
  `github.com:443` (see "No journey uses `glob` or `grep`" under J1).
- Every run makes `CONNECT models.opencode.ai:443`, which is tolerated (see
  Network).
- On Windows, OpenCode printed `failed to capture snapshot ... Filename too long`
  warnings. No action was taken; they are noted here only.

## Re-pinning OpenCode

1. Install the new version, and set `HARNESS_E2E_OPENCODE` to its absolute path.
   Run the journeys against it, with `HARNESS_E2E_REQUIRE=1` and
   `HARNESS_E2E_RECORD_DIR` set to a fresh directory:

   ```text
   HARNESS_E2E_OPENCODE=/absolute/path/to/opencode HARNESS_E2E_REQUIRE=1 HARNESS_E2E_RECORD_DIR=/absolute/path/to/records npm run e2e:opencode
   ```

   The suite refuses any version other than the pinned one. Read the failures and
   the retained records, and reconcile the observed behaviour above with them.
2. Update the version constant `REQUIRED_OPENCODE_VERSION` in
   `e2e/support/opencode-sandbox.ts`. Also update the job-level `OPENCODE_VERSION`
   and `OPENCODE_SHA256` in the `agent-e2e` job of `.github/workflows/ci.yml`, with
   the sha256 of the new release asset, and re-check `TOLERATED_STARTUP_DESTINATIONS`
   in `e2e/support/opencode-sandbox.ts`.
3. Re-run the suite and reconcile the observed behaviour above.

## Manual smoke procedure

Prerequisites: Node.js 24.x, `npm ci` at the repository root, and the OpenCode
2.3.0 executable at an absolute path. Steps 2 to 4 need `HARNESS_E2E_OPENCODE`
to be that path.

1. Run `npm run e2e:opencode` without `HARNESS_E2E_OPENCODE`. Every journey is
   reported as skipped, and the command exits 0.
2. Run it with `HARNESS_E2E_OPENCODE` and `HARNESS_E2E_REQUIRE=1`. The expected
   result is exit code 0 and **5 passed, 0 failed** across five tests: J1, J2, J3,
   and both J4 cases pass. A different count or any failure is a finding to report,
   not a pass.
3. Scope a sentinel change to one journey: in `e2e/opencode-journeys.e2e.ts`, change
   the text expected by J4a's second step (`toolResultsInclude`) to a different
   string, and run again. J4a run 1 fails on its assertion that the violation names
   the commit-subject sentinel (`J4a: the violation must name the commit-subject
   sentinel`), which is expected for this check. The suite exits non-zero. Run 2
   never executes, so no `.run2.json` is written. With `HARNESS_E2E_RECORD_DIR`
   set, only `violations-fail-deterministically-case-a.run1.json` is written; it has
   one violation at step 1 whose `expected` names the new string and whose
   `received` is the shell tool result. Revert the change afterwards. J4b has no
   expectation to change (its only scripted step has none), so this check does not
   apply to it.
4. Run with `HARNESS_E2E_RECORD_DIR` set to an absolute directory, and inspect
   `lead-reads-repository.json`: `network.unexpectedDestinations` is empty,
   `network.toleratedDestinations` holds at most the tolerated startup destination,
   and `credentialHeaders` is empty. Inspect `implementer-loads-skill-and-edits.json`:
   `outcome` is `"pass"`, `handoffCount` is 1, and the `skillInvocations` entry has
   `loaded: true`. No `Authorization` value appears in any record.
5. Missing-binary path. Run `npm run e2e:opencode` with `HARNESS_E2E_REQUIRE=1` and
   `HARNESS_E2E_OPENCODE` unset. The expected result is a non-zero exit status. The
   failing test is `OpenCode E2E preflight check`, and its message names the missing
   binary setting: `HARNESS_E2E_REQUIRE=1 but HARNESS_E2E_OPENCODE is not set`. This is
   case AE-05 in the [smoke test plan](smoke-test-plan.md).

Tests for the harness itself (`npm test`) and the smoke suite (`npm run smoke`)
never start OpenCode.

## Continuous integration

The `agent-e2e` job in `.github/workflows/ci.yml` runs on `ubuntu-latest` with a
20-minute timeout. The timeout covers the worst case of seven OpenCode runs at 150
seconds each (17.5 minutes), so setup and the download add further time. That
sizing covers the journeys file only. The runner e2e file is not run by this job. It is
kept out of CI for feedback-loop cost and runs on demand (`npm run eval:opencode:e2e`).
It is **not a required check**. Two pre-`#261` runs passed (`43974715793` on PR 262 at head
`172d19e`, and `44264679242` on head `3a901183d59a85ea8dc0a4871c4105151b1e0684`, with
6 tests: 5 pass, 0 fail, 1 todo for J3; on `44264679242`, all seven journey records
showed `enforcement: "netns"`, `CONNECT models.opencode.ai:443` was the only tolerated
destination, there were no unexpected destinations or credential-shaped headers, the
sha256 check passed, the executable was found in the archive, and `sudo unshare --net`
worked on the hosted runner). `#261` added per-role `skill.load` allow rules, enabled
J3, and retired J3a (leaving 5 tests / 7 OpenCode runs); CI `agent-e2e` verification of
the enabled 5-test suite on the current PR head is pending the workflow run on Ubuntu
(Node 24, OpenCode 2.3.0). Live OpenCode and interactive TTY spot-checks remain
**waived**, not passed, and local Windows runs remain non-hermetic. The job runs on the
same events as the other CI jobs. The decision is recorded in
[ADR-0011](adr/0011-deterministic-agent-e2e-via-loopback-model-fixture.md).

1. Checkout (without persisted Git credentials), Node.js 24.x, and `npm ci`.
   Dependencies are installed before the network namespace is entered.
2. Download `https://github.com/anomalyco/opencode/releases/download/v2.3.0/opencode-linux-x64.tar.gz`
   with `curl --fail --retry 3` into a fresh directory under `$RUNNER_TEMP`. The asset
   is `opencode-linux-x64.tar.gz`, 121569810 bytes.
3. Check its sha256 against the job-level `OPENCODE_SHA256` value with
   `sha256sum --check`. A mismatch fails the job before extraction. The version and
   digest are job-level values, so the CI pin is in one place. A re-pin also changes
   `REQUIRED_OPENCODE_VERSION` (see [Re-pinning OpenCode](#re-pinning-opencode)).
4. Extract into a fresh directory under `$RUNNER_TEMP`. The archive layout is not
   pinned, so the job locates the single regular file named `opencode`. Zero or
   several candidates fail the job. The file is made executable, and its absolute
   path is exported as `HARNESS_E2E_OPENCODE` through `GITHUB_ENV`.
5. Create `$RUNNER_TEMP/e2e-records` as the runner user, then run `npm run e2e:opencode`
   inside `sudo unshare --net`, which starts a new network namespace. Inside it only
   loopback is brought up. The command runs as the runner user, not root. The suite
   receives `HARNESS_E2E_OPENCODE`, `HARNESS_E2E_REQUIRE=1`, `HARNESS_E2E_NETNS=1`,
   `HARNESS_E2E_RECORD_DIR`, `PATH`, and `HOME`, and nothing else. `sudo` resets the
   environment to its policy defaults, and `env` then sets the listed variables, so no
   proxy or runner variable is inherited beyond the sudo defaults.
   `HARNESS_E2E_NETNS=1` makes the suite check that the interfaces are loopback
   only; the namespace itself is created by the job, not by the suite.
6. An `if: always()` step uploads the records directory as the
   `agent-e2e-journey-records` artifact, so a failing run keeps its records. The
   records replace the sandbox root and the parent's home directory with
   placeholders, record no credential value, and list no hosts beyond the recorded
   destinations. Other absolute paths that a tool result quotes are not rewritten
   (see [Determinism rules](#determinism-rules)). The step warns, and does not
   fail, when no record was written.

The job reads no secrets and passes no API keys to the suite. Checkout uses the
workflow's default token, with `persist-credentials: false`, so the token is not
left in the Git configuration. The default token has `contents: read`.

## Documentation impact

BH-034 changes these documents: this guide, the [glossary](glossary.md) (Testing
terms), [ADR-0011](adr/0011-deterministic-agent-e2e-via-loopback-model-fixture.md)
and the ADR index, the top-level README, the changelog, and the
[smoke test plan](smoke-test-plan.md). The CI job is in `.github/workflows/ci.yml`.
The agent contracts, `AGENTS.md`, and the `e2e` project check (`unconfigured`) are
unchanged. The older OpenCode 2.0.26 references in other documents are not updated
by this change.
