# Backlog

Last consolidated: 2026-10-11. This is the durable recovery index for **known pending
work**, not just deferred features. Update it when scope/status changes; do not rely
on a conversation summary or a person's memory. Unknown/unreported work is not
invented. Links point to the current implementation/specification.

## How to resume safely

1. Read this file, [README.md](../README.md), [configuration.md](configuration.md),
   and the target project's AGENTS.md/referenced context.
2. Inspect actual Git status, current source/configuration, and any PR/service state
   before acting. The snapshot below is dated and may no longer match the machine.
3. Pick a backlog ID and propose its latest scoped plan. **A backlog entry is not
   approval to implement, execute commands, change settings, publish, or clean up.**
   Prior conversational decisions must be confirmed when their context is missing.
4. Record results, remaining gaps, and the next concrete action here. Mark required
   checks missing/not-run/waived explicitly, never infer a pass from setup/catalogs.
5. Review and commit these notes with the harness changes when the human approves;
   uncommitted files persist locally but are not protected by repository history.

## Latest known state (reported/observed, not a fresh machine audit)

- Harness checkout: `C:\Users\jcgse\Documents\Advanced Harness`, delivery branch
  `feature/native-harness-setup`, tracking `origin/feature/native-harness-setup`.
  The previous `Advanced Harness-worktrees/enforcement-prototype` location became
  empty; do not use it as the development checkout.
- Installer, agent/model diagnostics, Android setup, optional global integration
  setup, and project-context storage are implemented locally. Latest typecheck and
  77 automated tests passed; one opt-in live test was skipped in the default suite.
  The 28-file delivery, including recovery documentation, was committed as
  `b12d954db97b97e3d33eb6b9c5e530ff9d2b0f48` and pushed to the harness origin.
  Remote-head equality was freshly verified. Harness PR
  https://github.com/IkariMeister/advanced-harness/pull/2 is now open into `main`;
  no merge or live prompt deployment has been performed for this delivery.
- All eight roles were discovered and passed small inference checks. Successful
  responses did not expose exact runtime model/variant metadata. Catalog checks
  are not inference/entitlement proof; inference checks are not tool/approval proof.
- Operator/External's Spark model failed with the tested ChatGPT account. The human
  approved `openai/gpt-6-luna#low` for both in the machine's global configuration;
  their subsequent inference checks passed. This is not a universal source-template
  model replacement, nor authorization for future silent substitutions.
- Global integration defaults saved by the user: GitHub `gh` on `github.com`, Jira
  alias `jira` at `https://mcp.atlassian.com/v2/mcp` (disabled), design `none`.
- Pilot app: `$HOME/Projects/MarsRoverIA`; canonical GitHub `IkariMeister/MarsRoverIA`.
  Project integration context was saved in AGENTS.md with GitHub `gh`, **Jira none**,
  design none, and access/mapping verification still unverified. `gh` CLI/auth status
   passed. The user subsequently reported a successful External read-only repository
   check (exit 0), canonical identity `IkariMeister/MarsRoverIA`, permission `ADMIN`,
   and no shell/permission errors. Publishing and broader tool permissions remain
   unverified. A global Jira connection does not select it for this app.
- Earlier Android settings were saved in `.opencode/harness.project.json` with an
  AGENTS.md pointer. Current tooling instead embeds settings directly in context;
  actual migration of this app's Android settings has not been reported. Legacy
  files and unrelated local changes must not be deleted or overwritten automatically.
- Android build/unit tests passed before the proposed lint fixes. Lint found four
  API-24 `Iterable.forEach` calls with min SDK 21. The current fix/recheck state is
  unknown; do not count earlier passes as verification of later changes.
- Validation used process-only Android Studio JBR JDK 21.0.10; Gradle found cached
  Java 17.0.19 offline. Reported stack: Gradle 9.6.1, AGP 9.0.1, Java/Kotlin toolchain
  17. Permanent environment changes/downloads were not approved by those checks.
  Device/E2E and additional gates below remain unresolved.

## Pending work index

| ID | Priority | Item | Status / next action |
| --- | --- | --- | --- |
| BH-001 | P0 | Finish MarsRoverIA fix pilot | Five checks/final approval reported; three unavailable gates waived for this fix; commit 16256ca |
| BH-002 | P0 | GitHub access, publishing, merge, cleanup pilot | Human reports PR #35 created manually; review/CI, human merge, and requested cleanup remain; External child execution unresolved |
| BH-003 | P0 | Consolidate and preserve harness delivery | Harness PR #2 open; review/required checks, human merge, and separately approved deployment remain |
| BH-004 | P1 | Full Android verification setup | Confirm Spotless/Detekt and runtime/device/E2E/snapshot contracts |
| BH-005 | P1 | Live context migration and global/project separation | Offer explicit legacy-to-context migration; verify preservation |
| BH-006 | P1 | Safe installer upgrades and permission reconciliation | Preserve reviewed models/integration rules through upgrades |
| BH-007 | P1 | Optional Jira end-to-end validation | Enable/authenticate only with approval; validate a selected project's mapping |
| BH-008 | P1 | Optional design integrations | Validate one selected Figma/Stitch connection/tools; no silent fallback |
| BH-009 | P1 | Effective runtime tools/permissions | Delegated smoke passed; approved source guidance/regressions implemented; live prompt deployment and broader ownership validation remain |
| BH-010 | P1 | Interruption, resume, and uncertain operations | Pilot human-confirmed resume and inspect-before-retry behavior |
| BH-011 | P2 | macOS/LiteLLM portability | Obtain real deployment/reasoning mappings and run a macOS pilot |
| BH-012 | P2 | Shared-memory/bootstrap/consolidation pilot | Validate agreed paths, serialized updates, and approved rule promotion |
| BH-013 | P2 | Setup UX and discovery improvements | Address confusing confirmations, Gradle aliases, and diagnostics |
| BH-014 | P2 | Optional evidence and practical reuse | Add only when pilot needs justify it; never silently make it a gate |
| BH-015 | Deferred | Multi-squad shared-repository workflows | Agree per-session routing/concurrency rules before implementation |
| BH-016 | Deferred | Team/cross-machine coordination and other hosts | Separate product decision; no synchronization/daemon promised |

Priorities are proposed delivery order, not new implementation authorization.

## BH-001 — Finish the Android fix pilot

2026-10-10 update (user-reported): all five configured checks passed and final
implementation approval was received. The human explicitly waived runtime, E2E,
and Roborazzi for this scoped fix because those gates are unavailable; record them
as **WAIVED, not passed**, and disclose them in the PR. These are not blanket future
waivers. Commit `16256ca` on `feature/api21_lint_fixes` and a clean worktree were
reported; author identity was applied to that commit only. Local `git worktree list`
freshly confirms that branch at `16256cac38e2a85b11be3f16cbcfb208d8a62d01`.
The earlier snapshot/finding checklist below remains historical context, not a
claim that implementation approval is still missing for this unchanged fix.

Scope: inspect the app's current branch/worktree and preserve AGENTS.md/context and
all unrelated app changes. The recommended finding disposition was to accept only
four API-21-compatible loop replacements, defer the material-icons catalog cleanup,
and defer D8/Kotlin/tooling investigation. The final acceptance/implementation state
was not reported here; verify it rather than inventing approval or completion.

Acceptance / next actions:

- Present exact affected files, behavior-preserving changes, and verification scope.
- Obtain current scoped approval before edits; return for approval on material changes.
- Rerun build/lint/unit after fixes and resolve required project gates (BH-004).
- Track version-catalog and D8 warnings explicitly as deferred findings, not discarded
  or passed. Investigate separately only after an approved plan.
- Present findings/results and request final implementation approval before publishing.

## BH-002 — GitHub access and complete publishing lifecycle

Latest user-reported publication: the human manually created
https://github.com/IkariMeister/MarsRoverIA/pull/35 from
`feature/api21_lint_fixes` into `main` using GitHub CLI. The provided PR body names
commit `16256ca`, five passing configured checks, and the scoped runtime/E2E/Roborazzi
waivers as **WAIVED**, not passed. This supersedes the publication-blocked snapshot
below for the human workaround, but does not validate External's delegated execution.
PR contents, current CI/review state, merge, and cleanup have not been freshly
verified here. Next: review the PR and required checks; human-only merge, followed
by human-requested merged-state verification and safe cleanup. No merge or cleanup
is authorized by reporting the PR URL.

2026-10-10 update: the human approved pushing/opening the PR for the current scoped
fix, with the three verification waivers above; no merge approval. Publication is
reported blocked because External says it has no shell/gh execution tool.
Fresh sanitized filesystem and `/api/agent` inspection confirms External is visible
and has `shell *`, `shell gh *`, `shell gh.exe *`, and `execute *` set to **ask**
in both the canonical app location and the feature worktree. No permission/config
change or service restart was made; no push/PR was performed here. The first
feature-location catalog response omitted External; a second returned all roles.
This suggests initialization/session/tool-discovery needs checking, but does not
prove a cause or successful tool execution. Next: have Lead launch a fresh External
child, discover native shell tools (including Code Mode catalog if needed), and
report actual missing-tool/denial evidence before granting anything broader. Keep
human tool prompts and inspect remote state before retrying uncertain publication.

Further user report: a fresh External child found no callable native shell/Git/
GitHub tool; Code Mode `search({query:"shell execute",limit:50})` returned an empty
catalog result. No execution was attempted and no permission error occurred; nothing
was pushed/published. Permissions remain ASK. Treat this as a reported tool-exposure
blocker, not a reason to broaden grants. Code Mode search alone does not enumerate
the separately exposed native tools: the V2 tools guide documents native `shell`
separately from Code Mode. Next diagnostics require the affected child session ID,
its actual native tool list, and client/service/version/location identification;
compare the session's tool exposure with effective agent permissions before choosing
a fix. Do not add undocumented legacy `tools` fields or restart an active service
without approval.

Correction and fresh API metadata (2026-10-10): the child did discover browser
tools; only its `shell execute` query returned no matches. Its reported native
callable surface was `functions.execute` alone. Read-only API inspection of
`ses_ed82e9bfaffeS6P1vtXIHh86cK` confirms agent `external`, model
`openai/gpt-6-luna#low`, location `C:\Users\jcgse\Projects\MarsRoverIA`, and server
version `2.0.26`. The inspected message page records two `execute` tool calls and
no native shell calls. This does not enumerate every tool offered to the model or
prove the root cause. No configuration changes, model substitutions, restart, or
publication occurred. Next proposed diagnostic, awaiting approval: use an isolated
temporary configuration to compare native tool exposure with/without External's
blanket deny rule, keeping the same model and requiring ASK for execution. Limit
execution to a read-only version probe; never apply broad permissions to the live
role or publish as part of the diagnostic.

2026-10-11 approved isolated diagnostic results:

- Disposable evidence/configs/scripts retained at
  `$HOME/Projects/harness-tool-exposure-20261011`; no live configuration, original
  session, service lifecycle, or application/remote Git state was changed.
- Same model `openai/gpt-6-luna#low`, copied External rules, primary probe roles:
  both with and without the blanket deny exposed native `functions.shell` and
  completed exactly `gh --version`, exit 0 (`gh` 2.96.0). Each real shell request
  retained ASK and received an exact-command **once** reply, not a saved grant.
- A browser-only session permission overlay, and browser plus shell ASK overlay,
  both reported native shell. The original child's browser-only session overlay
  therefore is not a sufficient explanation either.
- A separate isolated API-created session using the actual installed `external`
  role (unchanged model/system/permissions, browser-only overlay) also completed
  native `gh --version` after one exact-command ASK approval. Session:
  `ses_ed8286426ffeeUImuOBjLeW30a`. This was not delegated through Lead's subagent
  tool and does not establish tool availability in the blocked child.
- Initial CLI-run attempts failed before inference with agent-not-found errors;
  API agent discovery later found both probe definitions, but CLI run still failed.
  Explicit location/agent API-created diagnostic sessions worked. Initial and later
  outputs are retained, not labeled as successful CLI validation.
- No root cause proven, no blanket-deny removal justified, no push/PR performed.
  Next proposed step: obtain approval to compare an actual delegated disposable
  External child against the working standalone session with the same exact native
  version probe. Preserve ASK and do not broaden permissions or substitute roles.

Follow-up delegated-child report: `ses_ed825f388ffeeeb65aXcE4scY1` said native
shell was unavailable but could not inspect literal definitions; its exact exposed
tool list remains **unverified**. Fresh read-only API inspection confirms `external`,
`openai/gpt-6-luna#low`, the MarsRoverIA checkout, the same Lead parent and browser-only
session overlay. Its inspected messages contain no tool calls. `gh --version` was
not attempted, so this is neither an execution failure nor a permission denial.
Stop repeating model self-report probes as proof of tool absence. Next requires
server-side offered-tool evidence/child-versus-standalone investigation; any diagnostic
instrumentation, restart, role substitution, or issue publication needs its own
approval. A human may choose manual approved publication as an explicit workaround;
none has been performed or selected here.

Depends on BH-001 for publishing. Read-only repository access is **reported passed**
by the user: canonical `IkariMeister/MarsRoverIA`, viewer permission `ADMIN`, exit 0,
and no shell/permission errors. This verifies that check, not publication permission
approval, all tool policies, or a completed PR lifecycle.

The initial attempt used PowerShell environment syntax in a Bash runner and failed
to target the host explicitly. The human approved a one-command Bash adjustment;
the successful retry was:

```bash
GH_HOST=github.com gh repo view IkariMeister/MarsRoverIA --json nameWithOwner,url,viewerPermission
```

This was process-local and read-only; no persistent shell/environment changes or
repository writes were reported. It does not replace configured PowerShell Android
validation commands. Track runner/shell mismatch under BH-013.

- Completed substep: the approved, explicitly host-targeted read-only identity/access
  check above. Recheck if account/host/repository/permissions change; do not retry blindly.
- Operator confirms the approved branch/worktree/local Git state before remote actions.
- After final human approval of current work/checks, External pushes and opens a PR.
- Verify repository-required checks/reviews; process feedback through scoped finding
  decisions. Agents never merge.
- Human merges; only after a human asks, verify merged state and perform safe cleanup.
  Preserve uncommitted/unpushed work. No push/PR/merge/cleanup completion is currently recorded.

## BH-003 — Consolidate the harness changes into recoverable Git history

2026-10-11 consolidation review (human approved proceeding with review, not yet
commit/publication): inventoried 28 changed/untracked harness source/test/doc files.
No app files, live OpenCode config, credentials/backups, or disposable runtime
evidence are part of that candidate set. A bounded recognized-token/private-key
pattern scan found no matches; this is not proof that all sensitive data is absent.
Fresh typecheck passed, 74 tests passed and one opt-in live test skipped;
`git diff --check` passed. No additional lint/build commands are configured in
`package.json`. No files were staged, committed, or published during review.

Findings requiring a scoped fix decision before consolidation:

- **BH-003-F1 (correctness):** `src/project-context.ts` counts marker substrings
  throughout the block while serializing payload strings verbatim. A valid confirmed
  command containing `<!-- advanced-harness:project:start -->` passes profile
  validation, but the generated context then fails `contextData` with ambiguous
  markers. Reproduced purely in memory with no filesystem writes or execution.
  Proposed minimal fix: JSON-escape `<` within embedded payload strings, preserving
  exact JSON roundtrip values and existing strict marker checks; add regressions for
  both section markers, repeat updates, BOM/CRLF, and independent section preservation.
- **BH-003-F2 (instruction consistency):** older Lead/External sequence/design
  paragraphs and README lifecycle/product status still imply required Jira/design
  fallback or claim already implemented tooling remains undelivered. They conflict
  with current independently optional global/project-context choices. Proposed fix:
  align those paragraphs with explicitly selected services and project/task criteria,
  without silent fallback or new runtime behavior; add optional-service prompt checks.

Proposed consolidation groups after accepted fixes and fresh validation:
native diagnostics/installer verification; context-only setup and optional global
connections/integrations; source guidance/regression tests; product/recovery docs.
Legacy migration inputs remain intact. Preserve source model/frontmatter permission
assignments and require separate approval for installed prompt changes. Obtain explicit
local commit scope/branch approval, then separate publishing approval; do not infer
either from review or the Android pilot's publication approval.

2026-10-11 accepted review fixes implemented and validated:

- **BH-003-F1 resolved in source:** embedded JSON escapes `<` as `\u003c`, so user
  strings cannot introduce section delimiters. Decoding restores exact original
  commands/values. Existing strict malformed/duplicate marker checks remain intact.
  Regressions cover all project/integrations start/end marker strings, comparisons
  and literal escape strings, BOM/LF/CRLF, independent sections, idempotent updates,
  and a validated configured command through the real setup preparation path.
- **BH-003-F2 resolved in source:** Lead/External and README now use explicitly
  selected services and project/task acceptance criteria with no design fallback.
  Jira updates require selection plus approved mapping/update scope. README now
  accurately distinguishes implemented tooling from outstanding live validation.
  Regression coverage rejects the obsolete fallback wording and required-service
  assumptions. Models/frontmatter permissions are unchanged.
- Fresh typecheck passed; **77 tests passed**, one optional live test skipped;
  `git diff --check` passed. No live deployment, app edits, staging, commit, push,
  or PR was performed for these fixes.
- Prepared commit scope remains the 28 harness source/test/doc files inventoried
  above: diagnostics/installer verification, context-only Android setup, independently
  optional global integrations, evidence-based tool guidance, and recovery/product
  documentation. Excludes installed settings, credentials/backups, app files, and
  external diagnostic evidence. Proposed branch `feature/native-harness-setup`;
  proposed local commit `feat: add native harness setup and diagnostics`.
  Await explicit approval of that local branch/commit scope. No push/publication or
  installed prompt deployment is included. Broader backlog items remain pending.

Subsequent human direction authorizes the proposed local branch/28-file commit and
pushing that branch. Fresh preflight confirms the origin push destination is
`https://github.com/IkariMeister/advanced-harness.git`, no preexisting staged files,
no existing local target branch, and no remote head at
`refs/heads/feature/native-harness-setup`. Git author/committer identities are already
configured; no identity settings were changed. Commit/push references will be
recorded only after success. No force-push, PR creation, merge, installed prompt
deployment, or app changes are included in this authorization.

Delivery result (2026-10-11, freshly verified): commit
`b12d954db97b97e3d33eb6b9c5e530ff9d2b0f48`
(`feat: add native harness setup and diagnostics`) contains the approved 28-file
scope on `feature/native-harness-setup`. Push with upstream succeeded to
`https://github.com/IkariMeister/advanced-harness.git`; `git ls-remote` confirmed the
remote head equals that commit. This recovery-note update is a documentation-only
follow-up to preserve the existing delivery reference in Git history. No forced
updates, app operations, harness PR, merge, or installed prompt changes occurred.
Local commit/push consolidation is complete; PR/release and live prompt deployment
remain separate decisions. After any subsequent note commit, verify the branch's
remote SHA again rather than assuming the remote still points at the delivery SHA.

Subsequent human approval requested opening the harness PR. Created and freshly
verified **OPEN**, non-draft PR
https://github.com/IkariMeister/advanced-harness/pull/2 from
`feature/native-harness-setup` into `main`; no existing PR was found before creation.
Its body records the 77 passing tests/one skipped live test, scoped diagnostic result,
and outstanding validation/deployment limitations. This recovery update records the
existing PR reference, not new product scope. Required CI/review results and merge
are not yet verified. Next: review the harness PR and its required checks, then
human-only merge. Installed prompt deployment and any cleanup require separate
approval; the Android pilot's PR is not the harness deliverable.

Review the local installer/doctor/setup/integrations/context tests, source templates,
spec/docs, and backlog together. Separate unrelated work, run typecheck/tests and
configured review checks, then obtain explicit commit/publishing approval. Record
commit/PR identifiers here after they exist; none is invented for the current changes.

Acceptance: reviewed source and recovery notes are committed; an agreed delivery/PR
workflow does not install historical plugins, copy credentials, or reset user settings.
Document that source-template prompt changes are not automatically deployed into
already-installed agent definitions.

## BH-004 — Required Android checks, devices, screenshots, and E2E

- Spotless/Detekt are project gates identified in AGENTS.md, not substitutes for Android
  lint. Their execution was left outstanding earlier; confirm the exact tasks and approval.
- Confirm shell invocation and compatible Gradle runtime/toolchain in the actual runner.
  Do not change toolchain 17 to 21 or install/download JDKs silently.
- Verify physical-first device availability, otherwise agree an emulator/serial and
  instrumented-test/runtime commands and expected results.
- Roborazzi was not found in the inspected configuration. A custom Robolectric screenshot
  test is not proof of a snapshot-comparison workflow. Agree whether/how to configure
  snapshot verification and its baselines; new dependencies require their own approved plan.
- A JVM Robolectric test named E2E is not evidence of device-based E2E. Obtain the private
  E2E invocation contract/prerequisites, or explicitly choose the intended test strategy.
- Keep unconfigured/not-run checks outstanding; only a specific human waiver can waive
  a required check. Optional screenshots/video/logcat publication is separate (BH-014).

## BH-005 — Live context-only project settings and migration

Tooling is implemented and unit-tested; the app's actual Android context migration
has not been reported. Setup must write project settings only into AGENTS.md or an
explicitly referenced project Markdown file. Global settings contain connections,
agent permissions, and defaults, not repositories/Jira project identifiers.

- Offer legacy profiles as suggestions only with explicit `migrate` consent, followed
  by final preview/confirmation; preserve files and unrelated instructions.
- Verify global-only, gh-only, Jira-only, design-only, all-none, and overridden project
  selections in real installations. None is not a setup blocker and does not disable
  a reusable global server needed by another project.
- Test alternate context references and worktree availability, plus preservation of
  existing local OpenCode overrides. Do not promote endpoints/credentials globally
  or delete obsolete files without a separate confirmed scope.
- Confirm new Lead sessions actually read the selected context and do not automatically
  consult retained legacy profiles.

## BH-006 — Safe reinstallation, upgrades, and managed permission lifecycle

Current installation replaces owned native role fields (including permission arrays)
after confirmation; integration setup appends reviewed rules and intentionally does
not revoke obsolete grants. An upgrade/reinstall can therefore lose integration rules
or reintroduce source-model suggestions unless reviewed carefully.

Propose a merge/upgrade strategy, managed-rule provenance/reconciliation, explicit
review of obsolete grants, and restore guidance that preserves later user changes.
Keep backups/concurrent-edit/symlink safety. Preserve the user's supported Luna mapping
and other model customizations; source-default changes need explicit product decisions.
Acceptance: repeat setup and upgrades do not silently reset models, lose intended
permissions, broaden access, delete credentials, or discard user edits.

## BH-007 — Optional Jira connection, project access, and lifecycle mapping

The global `jira` entry is disabled; MarsRoverIA has Jira **not selected**. Do not
enable it or ask for a project key merely to complete that project's setup.

When a task/project needs Jira:

- Approve enabling the real endpoint, complete OAuth in `/mcps`, and verify connection.
- External discovers exact tools, then performs separately approved read-only project,
  issue, status, and transition checks. Catalog/connection status alone is insufficient.
- Confirm destination mappings for the applicable project/issue type and explicit
  lifecycle-update scope; status IDs are not assumed to be transition IDs.
- Test sync failure and inspect-before-retry handling without duplicate comments or
  writes. Separate account boundaries use separate global connection aliases as needed.

## BH-008 — Optional Figma/Stitch validation

Configuration selection is supported; no live design connection/access validation is
recorded. Obtain real endpoint/account/project references, discover normalized tools,
and validate access/role permissions with approval. Select one design source (or none)
in project context. Never silently combine or substitute services, and do not enable
design integration for a project/task that does not need it.

## BH-009 — Effective tools and role ownership

2026-10-11 approved harness diagnostic: historical session APIs/logs did not retain
the originally offered tool definitions. Active plugin inventories in the app and
earlier disposable location contained only built-ins. No evidence established a
third-party harness plugin deleting shell tools.

A disposable observer was loaded only in
`$HOME/Projects/harness-tool-exposure-20261011/request-capture`. It recorded tool
names, session/agent/model identifiers at context assembly and final provider
WebSocket send; no prompt text, credentials, headers, schemas, or tool arguments.
It did not mutate requests/registries/permissions. This is diagnostic instrumentation,
not a product plugin or enforcement host. Live app/global config, original sessions,
models, and service lifecycle were untouched.

Fresh captured results (OpenCode 2.0.26, existing installed role definitions):

- Standalone External `ses_ed81dd0d4ffehINDeFNu2jkaKZ` and actual delegated External
  `ses_ed81da916ffebZ8KTu4Kq3Zaug` both received exactly these native tools in the
  assembled context and outgoing provider request:
  `glob`, `grep`, `read`, `shell`, `webfetch`, `websearch`, `execute`.
- Lead `ses_ed81db85cffe2Qx4kZOlfZOB6t` used native `subagent` to launch that child;
  no role substitution. Models stayed `openai/gpt-6-astra#medium` for Lead and
  `openai/gpt-6-luna#low` for External. The browser-only session overlay was retained.
- Both External sessions ran only `gh --version`, exit 0, gh 2.96.0. Shell ASK was
  preserved, with an exact-command once reply for each request and no saved grant.
- Evidence: `tool-names.jsonl`, `standalone-result.json`, `delegated-result.json`
  and session metadata/scripts in the disposable location above. No push/PR/merge
  or Android work was performed as part of this harness test.

Conclusion: delegated native shell exposure/execution works in the captured test;
the original session-specific blocker is **not reproduced**, and its root cause
remains unknown. This is not proof that every earlier request offered shell, that
all role permissions work, or that delegated publication is validated. No runtime
permission/model fix or OpenCode bug publication is justified by this result alone.

2026-10-11 source guidance change approved and implemented locally:

- Lead/External source prompts now distinguish native shell from Code Mode catalog
  search and require authorized invocation/error or captured offered-tool evidence
  before declaring a tool unavailable; otherwise availability remains unverified.
- Current optional integration discovery guidance and the legacy discovery helper
  use the same evidence guidance. Separately approved probes, ASK, no invented tool
  paths, no automatic retries/restarts, and no role/model substitutions remain explicit.
- Added `docs/tool-troubleshooting.md`, linked from installation/configuration docs,
  covering evidence levels, actual child-versus-standalone comparisons, names-only
  optional capture, and separate consent for installed prompt updates.
- Regression tests cover installer-loaded Lead/External systems and printed guidance
  for none, gh, and MCP backends. Source model/frontmatter permission assignments
  remain unchanged. No paid probes or live tool calls were added to default tests.
- Fresh verification: typecheck passed; 74 tests passed, one opt-in live test skipped;
  `git diff --check` passed. An initial new assertion failed on Markdown line wrapping
  and was corrected to normalize whitespace; the full suite subsequently passed.
- Changes remain uncommitted; no live agent prompt/config update, service restart,
  Android change, push, or PR was made for this source fix. The earlier captured live
  smoke preceded these prompt changes and is not a deployment validation.

Next: BH-003 review/consolidation/commit scope approval. Deployment of only the
reviewed installed prompts needs separate consent while preserving existing models,
permission arrays, connections, and unrelated settings; do not reinstall all roles
to apply a prompt-only change. Broader ownership/publishing checks remain open.

Static tests and runtime agent/model catalogs do not prove usable tool permissions.
Verify shell/Git/filesystem/MCP ownership in the actual installed version and location:
External owns services/remote Git/gh; Operator local Git/worktrees/memory; Implementer
source/tests; Reviewer/QA scoped verification. Check both direct MCP and nested Code
Mode actions, selected aliases, project overrides, and stale service/UI behavior.
Report missing/denied tools honestly. Permission patterns/instructions are not a shell
sandbox or independently enforced plan-approval gate; historical enforcement spikes
are not release prerequisites and must not be reintroduced as the product foundation.

## BH-010 — Interruption/resume and uncertain external outcomes

Pilot a context loss/interruption: Lead summarizes state and asks before resuming.
Verify that missing approval context is not invented, material plan changes return to
the human, and uncertain external operations are inspected before any retry. Record
results for plan approval, finding decisions, final publishing approval, and cleanup.
Do not promise automatic recovery, exactly-once mutations, or a new workflow database.

## BH-011 — macOS and LiteLLM

Obtain endpoint, deployment IDs, model availability, and reasoning/variant mappings
from the actual connection. No guessed IDs or silent model replacements. Validate
Node/CLI discovery, native agents, shell/Gradle/device commands, global connection
setup, OAuth, and project-context portability on macOS. Never copy Windows credentials.

## BH-012 — Shared memory, bootstrap, and approved instruction consolidation

Paths are recorded, not proof that worktrees/memory were created or permissions work.
Validate human-approved Operator bootstrap under visible `$HOME/Projects`, one agreed
shared MEMORY.md across feature worktrees, serialized writes, source/scope/confirmation
labels, deduplication, and conflict handling. Ask which observations should become
project rules; approve AGENTS.md changes before publication. Do not store secrets or
operational artifacts in application Git. Concurrent squads require BH-015 first.

## BH-013 — Setup UX and bounded discovery improvements

Observed opportunities, not approved implementation:

- The user twice entered `save` where only `setup` confirmed. Consider clearer prompts
  or an explicitly reviewed confirmation UX without introducing unattended writes.
- MarsRoverIA uses Gradle aliases/conventions; textual inspection detected no Android
  modules. Improve safe alias/convention/flavor/task discovery or explanations, while
  keeping suggestions unverified and never evaluating build scripts during setup.
- Improve actionable diagnostics for config source precedence, effective selection,
  hidden/disabled roles, shell mismatch, missing Java/toolchain/SDK/device prerequisites,
  and legacy context conflicts. Never echo secrets or auto-install/enable/retry.
- Validate installed-version API/tool-discovery support; current MCP status API does
  not expose a tool catalog, so manual External discovery remains explicit.

## BH-014 — Optional evidence capture/publication and practical artifact reuse

Add screenshots/video/logcat capture and analytics/publication only as useful pilot
needs justify them. External may publish requested evidence to Jira/PR when supported
and approved. Keep recordings/logs/operational evidence outside application Git; tests,
required baselines, and approved project rules follow normal Git review. Reuse clearly
matching artifacts where practical; sophisticated manifests/caches are deferred.
Evidence failures do not become a mandatory gate unless explicitly required.

## BH-015 — Multi-squad workflows in a shared repository

Status: deferred; recorded at the user's request. No implementation approved.

Support several squads working in the same repository with different Jira boards
on the same Jira instance. Reuse global MCP connections where authentication and
access boundaries permit; separate aliases may be needed for different accounts.

Proposed scope:

- Named squad profiles in repository AGENTS.md or explicitly referenced project
  context, not separate machine-local project settings.
- Each profile identifies its Jira connection alias, board ID, applicable projects,
  issue selection rules, and workflow mappings by project/issue type where needed.
  Boards are not assumed to correspond one-to-one with projects or workflows.
- Optional squad-specific verification rules, with conflicts surfaced to humans.
- Explicit squad selection per feature/session, propagated to all subagents.
  Never mutate a shared repository-wide active-squad setting or silently infer one.
- Revisit the current one-active-feature-per-project convention before supporting
  concurrent squad work. Define independent feature worktrees, appropriately scoped
  memory, and handling of shared resources without overwriting another squad's work.

Acceptance considerations:

- Two squads can select different boards/mappings in the same repository without
  changing each other's active context or Jira routing.
- Ambiguous issue/board/project membership requires clarification.
- Existing conversational plan/publishing approvals, human-only merge, optional
  integrations, and credential separation remain intact.
- Concurrency and memory rules are agreed explicitly before a live multi-squad pilot.

## BH-016 — Longer-term team/cross-machine coordination and other hosts

Deferred product decisions: team sharing, unfinished-state synchronization between
machines, broader concurrent-feature coordination, and agent hosts other than
OpenCode. They must not quietly enter V1 through a daemon, locking engine, or shared
approval database. Define authority, privacy, conflict/recovery behavior, and human
approval semantics separately before proposing implementation.

## Closure and maintenance

For each completed item, record dated results, relevant source/test changes, and
commit/PR identifiers when available; retain unresolved sub-items or move them to a
new ID rather than dropping them. Never label a request to record backlog as approval
to implement it. If evidence contradicts this snapshot, update the snapshot and ask
about any affected pending approvals.
