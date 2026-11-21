# ADR: Deterministic Agent E2E via a Loopback Model Fixture

**Status:** Proposed\
**Date:** 2026-11-16\
**Project:** Advanced Harness\
**Decision scope:** How the agent E2E suite drives a real OpenCode CLI without a live model, how the OpenCode binary is pinned, how outbound network use is detected and bounded, and what the suite and its CI job do and do not prove.

## Context

Issue 62 (BH-034) asks for an end-to-end check that the installed harness reaches a real host CLI and that Lead, its child roles, and their tools behave as installed. The existing smoke suite ([smoke test plan](../smoke-test-plan.md)) runs the real `harness:*` scripts against a deterministic stub binary. It proves the CLI wiring, not OpenCode's discovery, delegation, permission handling, or tool execution.

A live model is not usable as the basis for this check. Results would depend on provider access, model entitlement, and model behaviour, and they would not repeat. The check must therefore be deterministic and cost nothing. It must still exercise the real CLI and the real installer output.

Issue #225's evaluation contracts are merged. They define an evaluation result and do not consume the journey record, so this ADR does not depend on them for the record's shape. Issue #226 (the runner) is expected to map journey records into evaluation results; that mapping is out of scope for this ADR. The proposed mapping and outcome model are in [ADR-012](0012-evaluation-runner-bindings-and-outcome-model.md).

## Decision Drivers

1. Exercise the real OpenCode CLI, the real installed prompts, and the real permission policy, not a stub.
2. Make every model reply scripted, so a run repeats and needs no credentials or model access.
3. Keep the pinned binary verifiable from a published digest, so a re-pin is a visible, reviewed change.
4. Make a violation (an unscripted request, a mismatched expectation, an unoffered tool, or an unexpected network destination) fail with a precise, repeatable record.
5. Do not present a local observation or an unrun CI job as evidence that it has passed.

## Considered Options

### A. Extend the stub-binary smoke suite

The existing stub answers `opencode api` calls only. It cannot run an agent, a tool, or a delegation, so it does not prove what this ADR needs. Rejected.

### B. Drive a live model provider

Results would depend on credentials, provider access, and model behaviour. Runs would not repeat, and a failure would not show whether the harness or the model caused it. Rejected.

### C. Real OpenCode 2.3.0 with a loopback model fixture (chosen)

The suite runs the real binary against a 127.0.0.1 OpenAI-compatible fixture that replays scripted per-role steps. Each sandbox holds real installer output in a scratch Git repository. A journey passes only when its assertions hold and its record matches the expected violations. The fixture shows which role sent each request, not that the role used a particular model.

### D. Record and replay real model traffic

Recorded replies would drift from the pinned version and would need a re-recording step for every change. They also would not show that the current installed policy is applied. Rejected for this scope.

### E. Pin OpenCode by version string only

A version string does not identify the bytes that run. The release asset is pinned by its published sha256 (decision below), and the version is checked by the suite (`opencode --version` must report exactly 2.3.0).

## Decision

1. **The real CLI.** The suite runs OpenCode exactly **2.3.0**, given as an absolute path in `HARNESS_E2E_OPENCODE`. It never searches `PATH`. Any other version is an error.
2. **The fixture.** A loopback OpenAI-compatible fixture, bound to 127.0.0.1, answers each model request with the next scripted step for the requesting role. Auxiliary requests (OpenCode's tool-less title generation) are answered without consuming a step. A request with no step left is an unscripted-request violation. No model reply is generated.
3. **Installed output.** Each sandbox holds real installer output for OpenCode at project scope, written by the installer's exported functions in the order the installer uses them, in a scratch Git repository. Nothing is installed into the real home directory.
4. **Journey record.** Each journey writes `journey-record.json` with `kind` `harness.opencode-journey-record` and `version` `1`. The record is a suite-level artifact, not an evaluation result. Issue #225's merged contracts (`eval/schemas/result.schema.json`, `src/eval-contracts.ts`) define the evaluation result, which records `handoffCount`, `roleTransitions`, and `skillsInvoked` under `metrics`. They do not define this record. The same concepts have different shapes in the two artefacts: the journey record's `roleTransitions` are `{seq, from, to}` objects and its `skillInvocations` are objects (`{seq, role, skillId, loaded}`), whereas the evaluation result's `metrics.roleTransitions` and `metrics.skillsInvoked` are arrays of strings. The one field correspondence checked against the schema is `handoffCount` (an integer in both). Mapping this record into an evaluation result, including the object-to-string conversion, belongs to the runner (#226). No field is renamed by this decision. The proposed mapping is in [ADR-012](0012-evaluation-runner-bindings-and-outcome-model.md).
5. **Non-interactive runs.** Journeys run with `--auto`. The CI job and local runs have no TTY, so each permission prompt would otherwise block the run. The installed policy still applies: `--auto` approved Operator's `ask` shell rule in the child session on the observed run, and the policy's denials still apply.
6. **Pin by digest.** The CI job downloads the GitHub release asset `opencode-linux-x64.tar.gz` for `v2.3.0` and checks its sha256 (`fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b`) before extracting. The version and digest are job-level values in `.github/workflows/ci.yml`. A re-pin also updates `REQUIRED_OPENCODE_VERSION` in the suite. The archive layout is not pinned: the job locates the single regular file named `opencode` and fails if there are zero or several.
7. **Network in CI.** The CI job runs the suite inside a new network namespace with only loopback up (`sudo unshare --net`). The suite does not create the namespace. When `HARNESS_E2E_NETNS=1` is set, the suite checks the claim before any journey runs: every interface address reported by `os.networkInterfaces()` must be internal. The check cannot tell a network namespace from a host with no active non-loopback interface; the CI job creates the namespace, and the suite only checks that no non-loopback address is present. If one is not, the suite fails and runs no journey as passing. `network.enforcement` is `netns` only when the flag is set and the check passed; otherwise it is `none`. The namespace guards against accidental egress. It is not a security boundary against a hostile binary, because the runner user has passwordless sudo. The sha256 pin (decision 6) is the protection for the binary's identity.
8. **Network locally.** Local runs start a loopback proxy recorder and set the proxy variables to it. Each accepted connection is classified as a tolerated startup destination or an unexpected one. Local runs detect attempts; they do not block them.
9. **The network guarantee.** The guarantee is that **no outbound call succeeds**. It is not that OpenCode never attempts one. The only tolerated destination is `CONNECT models.opencode.ai:443`, which OpenCode 2.3.0 contacts at startup on every observed run for a models catalogue refresh. No off switch was found. The list is the constant `TOLERATED_STARTUP_DESTINATIONS`, matched exactly on method, and on host (case-insensitively) and port. A plain-HTTP request to the same host and port is not tolerated. Any other recorded attempt fails the journey.
10. **Journeys avoid ripgrep-backed tools.** On 2.3.0, `glob` and `grep` download ripgrep 15.1.0 from `github.com` when `rg` is absent. No journey uses either tool.
11. **Not a required check.** The `agent-e2e` CI job is not a required check (BH-034 decision D6). The `e2e` entry in the project's `AGENTS.md` checks stays `unconfigured`.
12. **Retained records, credential check, and environment.** `HARNESS_E2E_RECORD_DIR` (absolute path) keeps a copy of each record under a deterministic file name. Every journey fails if any request, auxiliary requests included, carried a credential-shaped header (Authorization, X-Api-Key, Api-Key, or Cookie); the record holds header names only, never values. The child environment removes inherited variables by a pattern denylist (credential shapes, OpenCode, npm, Git, proxy, and launch-directory names), not by an allowlist, so an unlisted secret name is not removed by design. Every `GIT_*` variable is removed, and the HTTP, HTTPS, ALL, and NO proxy variables are removed in any letter case; local runs then set their own proxy variables (decision 8). Termination applies only to the child PID the suite spawned and its descendants by that PID.

## Consequences

**Positive:** The suite runs the real CLI and the real installed prompts and policy without a model, credentials, or cost. Violations fail with a repeatable record. The pinned binary is identified by its digest, and the re-pin point is a single place in the workflow.

**Negative:** The suite proves host plumbing only. It does not prove model quality or behaviour, model entitlement, that a role used a particular model, or anything about other OpenCode versions. Every model reply is scripted.

**Neutral:** The network guarantee relies on the namespace in CI. Locally, proxy-based detection sees only traffic that honours the proxy variables, so a client that ignores them is not counted. The stderr scan for non-loopback hosts is a hint for the human, not a guarantee.

### Limits that apply now

- **CI `agent-e2e` run `44845273743` for head `99c18069` passed 5/5 on PR merge ref `7276d92f` (Ubuntu, Node 24, OpenCode 2.3.0; 5 tests across 7 OpenCode runs, `enforcement: "netns"`, `CONNECT models.opencode.ai:443` tolerated, 0 unexpected destinations, 0 credential headers).** Earlier pre-`#261` runs (`43974715793` on PR 262 at head `172d19e`, and `44264679242` on head `3a901183d59a85ea8dc0a4871c4105151b1e0684`) also passed with 6 tests (5 pass, 0 fail, 1 todo for J3). Passwordless `sudo` and `sudo unshare --net` worked on the hosted runner, the single `opencode` executable was found in the archive, and the sha256 check passed. The job is not a required check, and live OpenCode / interactive TTY spot-checks remain **waived**, not passed.
- **Local Windows runs are not hermetic.** On Windows, OpenCode 2.3.0 still lists skills from the real home's skill directories in the system prompt. OpenCode also sets file watchers on the real user-profile directory, the real home's `.claude\skills` and `.agents\skills`, and a Temp path, despite the redirected environment. The journey record cannot show whether those were read. CI on Ubuntu is the authority.
- **All four scripted tool paths (`read`, `shell`, `skill`, `edit`) executed in CI run `44845273743`.** Whereas pre-`#261` runs executed only `read` (J1) and `shell` (J2) because Implementer lacked `skill.load` permissions (`Permission denied: skill`), CI run `44845273743` passed J3 (`skill` load of `harness-procedure-documentation-impact` and `edit` on `notes.md`) against the loopback model fixture. Live OpenCode / interactive TTY spot-checks remain **waived**, not passed.
- **J3 is enabled (`#261`) and J3a is retired.** `#261` adds per-role `skill.load` allow rules (allowing `harness-procedure-documentation-impact` on Implementer), removes J3's `todo` option, and folds J3a's transition, network, and credential-header assertions into J3, leaving 5 tests (7 OpenCode runs). Enabled J3 passed in CI run `44845273743` against the loopback fixture; live OpenCode / interactive TTY spot-checks remain **waived**, not passed.
- **The network namespace is not a security boundary.** It guards against accidental egress. The runner user has passwordless sudo, so a hostile binary is not contained by it. The sha256 pin protects the binary's identity.
- **Observed second local run (Windows, OpenCode 2.3.0, uncommitted tree, before J3a was added):** 5 tests, 4 passed, 1 `todo` (J3), 0 failed. The printed network record held the tolerated `CONNECT models.opencode.ai:443`, no unexpected destination, and `enforcement: none`. This is an observation, not a CI result. The suite now has five tests after `#261` enabled J3 and retired J3a (see the guide).
- **Re-pinning changes the proof.** A new version or digest requires re-checking the tolerated startup list, the journeys, and the observed behaviour, as the [agent E2E guide](../agent-e2e.md#re-pinning-opencode) describes.

## Adoption

Accepting this ADR does not change tooling, roles, permissions, or defaults, and it does not make the CI job a required check. The suite, the `agent-e2e` CI job, and the documentation are delivered with the BH-034 implementation change. That change is approved as its own plan, and it does not change the `e2e` project check, the agent definitions, or the permission policy.

Rollback removes the `agent-e2e` job from `.github/workflows/ci.yml` and the `e2e/` directory with its `npm run e2e:opencode` script. It does not modify machine configuration. The smoke suite and unit tests are unaffected.

## Reconsideration

Reopen this decision when one of these is observed:

- the `agent-e2e` job cannot create the loopback-only namespace on hosted Ubuntu runners, or it fails for reasons that are not in the suite;
- a re-pin changes the tolerated startup destinations, or OpenCode stops contacting `models.opencode.ai:443` at startup, so the tolerated list needs to change;
<<<<<<< HEAD
- enabled J3 fails on live/CI OpenCode 2.3.0 or a procedure-skill permission change alters expected `skill` behavior;
- the journey record is mapped into the evaluation result contract under #226, or its version 1 changes, which changes the record contract.
=======
- the installed policy's denial of `skill` to Implementer is fixed (remove J3's `todo` option) or is found to be intended (then J3's acceptance criterion needs a new decision);
- the journey record is mapped into the evaluation result contract under #226, or its version 1 changes, which changes the record contract (the proposed mapping is in [ADR-012](0012-evaluation-runner-bindings-and-outcome-model.md));
- the observed `skill` result changes so that the skill loads (J3a fails with a message saying defect #261 appears fixed).
>>>>>>> origin/main

This ADR is reviewed at each milestone close.

## References

- [Agent E2E suite guide](../agent-e2e.md)
- [Smoke test plan](../smoke-test-plan.md)
- [CI workflow](../../.github/workflows/ci.yml)
- [Glossary: Testing](../glossary.md#testing)
- [ADR-002: Consolidate agent responsibilities](0002-consolidate-agent-responsibilities.md)
- [ADR-008: Project guardrail policy](0008-project-guardrail-policy.md)
