# Host permission capability matrix

This is BH-048 ([#123](https://github.com/IkariMeister/advanced-harness/issues/123))'s evidence baseline for the conditional role consolidation in [ADR-002](adr/0002-consolidate-agent-responsibilities.md). It describes the current harness mapping, not every feature a host might provide. No role consolidation or permission change is authorized by this matrix.

## Reading the statuses

| Status | Meaning |
| --- | --- |
| enforced | Evidence establishes that the host prevents the action within the stated scope. |
| advisory | Instructions or non-enforcing configuration express the boundary. |
| unsupported | The current host mapping cannot express the required boundary. |
| unverified | Evidence does not yet establish whether the boundary is enforced. |

These use the [glossary](glossary.md#hosts-installation-and-permissions). Static regression tests establish what the harness emits or diagnoses, not live enforcement. Installation health, configuration syntax, catalog presence, and conversational approval never upgrade a cell to enforced. No current cell establishes enforcement of an entire boundary; narrower native guards can still exist.

Each cell below records documentation, regression-test, or attributed live-run evidence. An advisory combined skills/MCP cell does not mean every tool route is advisory: it means the complete exposure requirement is not enforced. Read the scope for component limitations. Model routing means actual per-role binding, not just accepting an ID or displaying a catalog; model configuration and discovery evidence from [BH-043 #70](https://github.com/IkariMeister/advanced-harness/issues/70) remains separate from entitlement and successful inference.

The canonical machine-readable rows are in [the capability registry](../src/host-permission-capabilities.ts). Native permission normalization remains in [capability-policy.ts](../src/capability-policy.ts); this matrix does not reinterpret native selectors or grant tools. The documentation/registry consistency test requires updates together.

## Summary

| Host | Same-role approval transition | Local/remote isolation | Per-role commands | Skills/MCP exposure | Actual model routing |
| --- | --- | --- | --- | --- | --- |
| [OpenCode](#opencode) | unverified | advisory | unverified | advisory | unverified |
| [Claude Code](#claude-code) | unverified | advisory | unsupported | advisory | unverified |
| [Antigravity](#antigravity) | advisory | advisory | advisory | advisory | unsupported |
| [Codex](#codex) | unverified | unverified | unverified | advisory | unverified |
| [Cursor](#cursor) | unsupported | unsupported | unsupported | unsupported | unsupported |

<a id="opencode"></a>

## OpenCode

| Capability | Status | Scope and limitation | Evidence |
| --- | --- | --- | --- |
| Read-only before approval, write/execute after approval for the same role | unverified | Separate Researcher/Implementer roles remain the baseline; the same-role approval transition has no recorded enforcement evidence. | [documentation](../docs/adr/0002-consolidate-agent-responsibilities.md); [documentation](../docs/opencode-native-workflow.md) |
| Isolation of local Git from external/remote writes | advisory | Role command patterns express ownership but are not a sandbox against scripts, aliases, indirect network access or same-user processes. | [documentation](../SECURITY.md); [documentation](../README.md#tool-and-integration-ownership) |
| Command execution scoped per role (Reviewer/QA re-run path) | unverified | Native allow/ask/deny policies compile per role; static policy tests do not demonstrate all command routes or Reviewer/QA runtime re-runs. | [documentation](../docs/opencode-native-workflow.md); [regression-test](../test/role-definitions.test.ts) |
| Skills and MCP tool exposure scoped per role | advisory | MCP rules are role-specific, but procedure-skill intendedRoles is advisory discovery guidance; the combined exposure boundary is not enforced. | [documentation](../skills/README.md); [regression-test](../test/procedure-skills.test.ts) |
| Per-role model routing | unverified | Explicit model/variant selection and runtime catalog comparisons exist; fixture tests and catalog presence do not prove a role used that model. | [documentation](../README.md#agents-and-fixed-per-host-model-presets); [regression-test](../test/opencode-model-catalog.test.ts); [regression-test](../test/native-diagnostics.test.ts) |

<a id="claude-code"></a>

## Claude Code

Host follow-up: [#43](https://github.com/IkariMeister/advanced-harness/issues/43). The Operator Bash bootstrap gap in [#200](https://github.com/IkariMeister/advanced-harness/issues/200) is addressed by the Proposed [ADR-005](adr/0005-claude-code-operator-bash.md): Operator gets Bash with advisory remote-Git denies.

| Capability | Status | Scope and limitation | Evidence |
| --- | --- | --- | --- |
| Read-only before approval, write/execute after approval for the same role | unverified | Read-only and write roles compile separately; no same-role approval transition is verified. Keep the split required by ADR-002. | [documentation](../docs/adr/0002-consolidate-agent-responsibilities.md); [regression-test](../test/claude-code-compiler.test.ts) |
| Isolation of local Git from external/remote writes | advisory | Operator has whole-tool Bash for local Git bootstrap (ADR-005, #200); its git push/pull/clone and gh denies are instruction-only and its Bash calls use Claude default prompts. Project settings deny destructive Git and git fetch --upload-pack/-u for every role. Not a sandbox. | [documentation](../docs/adr/0005-claude-code-operator-bash.md); [regression-test](../test/claude-code-compiler.test.ts); [documentation](../README.md#agents-and-fixed-per-host-model-presets) |
| Command execution scoped per role (Reviewer/QA re-run path) | unsupported | Per-role Bash patterns cannot be expressed; Operator and External receive whole-tool prompted Bash. Implementer, Reviewer and QA have no Bash; Reviewer/QA cannot re-run shell checks; request an authorized command-running context through Lead. | [regression-test](../test/claude-code-compiler.test.ts); [documentation](../docs/adr/0002-consolidate-agent-responsibilities.md) |
| Skills and MCP tool exposure scoped per role | advisory | Tools use allowlists, but MCP alias identities are unverified and procedure-skill intended-role guidance does not enforce discovery. | [regression-test](../test/claude-permission-preflight.test.ts); [documentation](../skills/README.md) |
| Per-role model routing | unverified | Explicit per-role aliases or model IDs are syntax-checked; runtime model assignment and availability are not verified (BH-043 #70). | [documentation](../README.md#agents-and-fixed-per-host-model-presets); [regression-test](../test/claude-code-compiler.test.ts) |

<a id="antigravity"></a>

## Antigravity

| Capability | Status | Scope and limitation | Evidence |
| --- | --- | --- | --- |
| Read-only before approval, write/execute after approval for the same role | advisory | Lead instructions select role tool groups; no independently verified same-role approval boundary is established. | [documentation](../README.md#agents-and-fixed-per-host-model-presets); [regression-test](../test/antigravity-compiler.test.ts) |
| Isolation of local Git from external/remote writes | advisory | Local/external ownership is instructional. Direct-command hooks are not isolation against indirect scripts or other processes. | [documentation](../SECURITY.md); [regression-test](../test/antigravity-compiler.test.ts) |
| Command execution scoped per role (Reviewer/QA re-run path) | advisory | Compiled write-tool groups include run_command; Lead must apply them. Emitted rules do not prove runtime Reviewer/QA command access. | [regression-test](../test/antigravity-compiler.test.ts); [documentation](../docs/installation.md) |
| Skills and MCP tool exposure scoped per role | advisory | MCP/tool-group ownership and procedure-skill intended-role discovery are guidance rather than independently established role isolation. | [documentation](../skills/README.md); [regression-test](../test/antigravity-compiler.test.ts) |
| Per-role model routing | unsupported | Runtime tiers and desired-model labels are available; exact per-role model binding is unsupported (BH-043 #70). | [documentation](../docs/configuration.md#4-antigravity-desired-model-preferences); [regression-test](../test/antigravity-model-preferences.test.ts) |

<a id="codex"></a>

## Codex

Host follow-up: [#45](https://github.com/IkariMeister/advanced-harness/issues/45). The linked #200 comment records a distinct Codex launcher startup failure. Its commands were executed by the agent under IkariMeister’s authorization; they are not human-performed interactive runs or proof of role isolation.

| Capability | Status | Scope and limitation | Evidence |
| --- | --- | --- | --- |
| Read-only before approval, write/execute after approval for the same role | unverified | Role-process profiles separate read-only and write roles; a same-role transition and complete isolation are not runtime-verified. Shared-sandbox subagents are not equivalent. | [documentation](../docs/installation.md); [regression-test](../test/codex-role-processes.test.ts) |
| Isolation of local Git from external/remote writes | unverified | Profiles configure network/MCP differences and command rules; these do not establish complete local/remote isolation across shell and tool routes. | [documentation](../SECURITY.md); [regression-test](../test/codex-role-processes.test.ts) |
| Command execution scoped per role (Reviewer/QA re-run path) | unverified | Per-process sandbox settings are tested statically; approved role launches and Reviewer/QA re-runs remain unverified. A launcher MCP override failed during startup (#200). | [regression-test](../test/codex-role-processes.test.ts); [live-run](https://github.com/IkariMeister/advanced-harness/issues/200#issuecomment-6716047378); runner: Codex agent, authorized by IkariMeister on 2026-11-08; agent-executed diagnostics, not a human interactive run |
| Skills and MCP tool exposure scoped per role | advisory | MCP selections are launcher-controlled, and child role processes run with Codex plugins disabled so plugin-provided servers are not selectable (#209), but runtime isolation is unverified; workflow skills are shared and procedure-skill deployment is not implemented (#45). | [documentation](../skills/README.md); [regression-test](../test/codex-role-processes.test.ts) |
| Per-role model routing | unverified | Each child requires a model and effort, re-applied on resume; successful role inference using those settings is not established (BH-043 #70). | [regression-test](../test/codex-role-processes.test.ts); [regression-test](../test/codex-model-catalog.test.ts); [documentation](../README.md#agents-and-fixed-per-host-model-presets) |

<a id="cursor"></a>

## Cursor

| Capability | Status | Scope and limitation | Evidence |
| --- | --- | --- | --- |
| Read-only before approval, write/execute after approval for the same role | unsupported | Native roles and permission boundaries are not deployed; compilation-only artifacts do not provide enforcement (#46). | [documentation](../README.md#scope); [regression-test](../test/multi-host-foundation.test.ts) |
| Isolation of local Git from external/remote writes | unsupported | Native roles and permission boundaries are not deployed; compilation-only artifacts do not provide enforcement (#46). | [documentation](../README.md#scope); [regression-test](../test/multi-host-foundation.test.ts) |
| Command execution scoped per role (Reviewer/QA re-run path) | unsupported | Native roles and permission boundaries are not deployed; compilation-only artifacts do not provide enforcement (#46). | [documentation](../README.md#scope); [regression-test](../test/multi-host-foundation.test.ts) |
| Skills and MCP tool exposure scoped per role | unsupported | Native roles and permission boundaries are not deployed; compilation-only artifacts do not provide enforcement (#46). | [documentation](../README.md#scope); [regression-test](../test/multi-host-foundation.test.ts) |
| Per-role model routing | unsupported | Native roles and permission boundaries are not deployed; compilation-only artifacts do not provide enforcement (#46). | [documentation](../README.md#scope); [regression-test](../test/multi-host-foundation.test.ts) |

## Pi

[#75](https://github.com/IkariMeister/advanced-harness/issues/75) owns Pi's future row and evidence. Pi is not registered or selectable by doctor today. This placeholder grants no host support and does not change the supported-host list. Cursor's existing doctor selection has an explicit unsupported row so that the `--host all` selection never silently omits it.

## Doctor behavior

Run the existing diagnostic command with an explicit host or allow scoped host detection:

```text
npm run harness:doctor -- --host codex --scope global --project <existing-directory>
npm run harness:doctor -- --host opencode --scope project --project <existing-directory>
```

Doctor prints the selected host's five statuses, scope, evidence references and live-run attribution. Both OpenCode's runtime path and the other hosts' structured reports use the same registry. Rows are printed even when no installation is detected; capability evidence is separate from installation health. Existing readiness checks and exit codes still apply. An exit of zero does not establish enforced boundaries. Missing access is unverified, never a passing enforcement result. The matrix itself performs no probes, starts no services and changes no settings. Existing OpenCode runtime diagnostics can still start the service as documented in [installation](installation.md).

## Updating evidence

For each changed cell, record the precise boundary, host/mode/version where known, evidence source, what it demonstrates, and remaining limitations. A regression test must point to the test that checks the mapping; it cannot stand in for a live host denial. A live run must identify who executed it and, for agent runs, the human who authorized it. Attribute human interactive evidence to that human and label agent execution separately; never claim to reproduce it without doing so. Contradictory or missing evidence stays unverified until resolved. Do not promote this session's launcher failure into a conclusion about all Codex permission enforcement.

Retain separate Researcher/Implementer and Operator/External roles wherever ADR-002's conditions are unmet. Reviewer reports whether checks were re-run or judged from evidence; unavailable shell access must be routed through Lead to an authorized command-running context, not silently waived. The Claude Code change under [ADR-005](adr/0005-claude-code-operator-bash.md) addresses only the Operator bootstrap in #200; it does not implement #181 preflight, deploy Pi, or change any other host's permissions.

## Smoke plan

Prerequisites: Node 24, locked dependencies installed, disposable home/project directories, and no live service configuration in those directories. Automated CLI fixtures use an absent OpenCode executable when testing runtime failure, preventing service startup.

1. Run the permission-matrix and native-diagnostics tests. Confirm explicit and detected host selection, exactly one row per selected host (including the all selection), all five capabilities, scope and evidence references, and all four status spellings.
2. Run doctor against empty disposable project/home fixtures for each supported host. Confirm the appropriate row appears even with no installation. Compare project/home file contents before and after; diagnostics must not alter them. Existing host readiness determines the exit code.
3. Supply a disposable OpenCode config and an absent CLI. Expect its row to appear before the existing inconclusive runtime error and the existing nonzero exit, with no unverified status promoted.
4. Check the registry/docs consistency test, typecheck, unit suite, documentation checks and existing smoke suite. These are agent-executed checks; independent Reviewer/QA validation is reported separately.
