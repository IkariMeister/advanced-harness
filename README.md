# Advanced Harness

A portable, human-controlled Android engineering workflow for OpenCode, with customizable agents, fixed models, deterministic approval gates, and local project memory.

## Status

Specification plus an **experimental enforcement-core prototype** and an **OpenCode V2 approval-boundary spike** in `spike/opencode/`. The globally installable harness, production OpenCode adapter, trusted human approval UI, integrations, Android verification, and production-grade checkout snapshotter are **not implemented**. Cloning this repository does not activate the harness. Do not use the prototype to authorize real code, GitHub, Jira, or other external actions.

The controller demonstrates revision-bound decisions and separate host/agent surfaces. An isolated OpenCode 2.0.24 server plugin loaded, but the plugin-RPC approval design is rejected: the RPC endpoint is an ordinary callable server route, not a human identity boundary. The combined suite currently has 17 automated tests. We have not runtime-validated agent tool filtering, shell/MCP bypasses, subagents, or an interactive approval surface. The chosen direction is an out-of-process trusted controller with a restricted local agent IPC channel and a separate interactive host console; see [`docs/host-controller-boundary.md`](docs/host-controller-boundary.md). This architecture is not yet implemented or proven secure, so do not use it for real actions.

## Scope

- V1: OpenCode on Windows and macOS, one active feature per project.
- Available globally across projects through a future global installation.
- Harness installation and configuration are portable; unfinished feature state does not need to move between computers in V1.
- Future: concurrent features and sharing with teammates using OpenCode or Claude Code.
- Initial stack: Android, Jetpack Compose, Roborazzi, and a private E2E framework.
- Services: Jira Issues, Figma or Stitch, and GitHub.
- Windows provider: ChatGPT sign-in within OpenCode. Mac provider: LiteLLM, with explicit machine-specific mappings.

## Architecture

The proposed implementation is a host-independent TypeScript workflow controller in a trusted host process with an OpenCode agent adapter. Agent instructions guide behavior; the controller authorizes actions and persists state. Human approvals are collected by a separate interactive host console, not through OpenCode plugin RPC. See [`docs/host-controller-boundary.md`](docs/host-controller-boundary.md) for the accepted boundary and remaining proof obligations.

The portable package will contain agent definitions, workflow rules, adapters, and installation tooling. Machine-local configuration will contain provider/model mappings and machine paths. Authentication stays in the relevant credential stores, outside this repository.

Each project has local storage outside its Git checkouts for workflow state, revision-bound approvals, memory, evidence, and build manifests. Stable project and feature identifiers should permit concurrency later; V1 enforces a single active feature per project.

## Agents and fixed models

Agents and subagents must be customizable. A lead agent selects subagents automatically, but cannot bypass human approval gates. Model and reasoning assignments are requirements, not suggestions; there is no silent fallback.

| Agent | Responsibility | OpenAI model | Reasoning |
| --- | --- | --- | --- |
| Lead | Coordinate stages, delegation, approvals, and progress | `openai/gpt-6-astra` | `medium` |
| Operator | Local Git, worktrees, shared memory, artifact manifests, cleanup | `openai/gpt-5.3-codex-spark` | `low` |
| External interactions | All MCP, service APIs, remote Git, ticket updates, PR operations, evidence publication | `openai/gpt-5.3-codex-spark` | `low` |
| Researcher | Inspect related code and investigate implementation context | `openai/gpt-6-luna` | `medium` |
| Planner | Prepare and revise the implementation plan | `openai/gpt-6.1-sol` | `medium` |
| Implementer | Write application code, tests, and approved fixes | `openai/gpt-6-luna` | `low` |
| Reviewer | Code review, Gradle build, lint, unit tests, Roborazzi | `openai/gpt-6.1-sol` | `low` |
| QA | Runtime verification, design comparison, E2E and evidence | `openai/gpt-6-luna` | `low` |

Model IDs and variants were found in the OpenCode catalog during planning. Catalog presence does not prove account access; validate each assignment against the selected connection. LiteLLM deployment IDs must be mapped explicitly on the Mac. If a model is unavailable, pause and ask rather than substituting it.

### Responsibility boundaries

- Only the external-interactions agent may use MCP, service APIs, GitHub/Jira tooling, or remote Git operations.
- Operator owns local Git commands. Reviewer can request diffs/history from Operator; QA does not need general Git access.
- Build/test agents may run Gradle dependency resolution. This is an explicit exception to the external-service boundary.
- Reuse matching build artifacts rather than rebuilding unnecessarily.
- Operator owns shared memory writes and deduplication; other agents submit observed facts.
- Application tests are written by Implementer. Reviewer and QA identify gaps and run checks; fixes arising from findings require approval.
- Provider connections used by OpenCode itself are runtime infrastructure, not delegated external-service actions.

## Human control and deterministic approvals

1. Use explicit human confirmation controls tied to a displayed revision. An agent interpreting conversational text such as “looks good” cannot unlock execution.
2. Approve the plan before implementation. **Every change to the plan returns to the human.**
3. Review and QA run after coding, before PR creation.
4. Findings can be accepted/discarded individually or as an explicitly enumerated batch. This applies to internal findings and later PR feedback.
5. Accepted findings authorize their corresponding fixes. A resulting plan change still needs separate plan approval.
6. Review/QA can rerun automatically after approved fixes. Fresh findings return to the human.
7. Final implementation approval authorizes pushing the approved revision and opening its PR. Later changes require fresh approval before pushing.
8. Approvals must not remain valid when their bound content changes. Code changes invalidate affected verification and implementation approval.
9. Always ask before resuming interrupted work, on ambiguity, on conflicting instructions, on missing configuration, and on synchronization failure.
10. Humans may override individual harness steps through explicit, revision-bound controls. Record what was overridden locally; a waived check is never reported as passed.
11. **Blanket “approve everything” is forbidden.** Agents cannot manufacture human approvals or overrides.
12. Human overrides do not bypass GitHub requirements and do not authorize the harness to merge. PRs are always merged explicitly by a human.

The controller must enforce gates at action execution, not merely when an agent proposes a transition. Broad shell or delegated tool access must not provide a bypass. Semantic deviation from a plan still requires review; a revision check alone cannot prove compliance.

## Feature lifecycle

### 1. Bootstrap and isolate

- Operator may inspect local Git and project `AGENTS.md` to identify the repository and base branch before worktree creation.
- Base branch is project-specific and comes from `AGENTS.md`. Ask for missing settings and save the answers in local `MEMORY.md`.
- Create a dedicated feature branch/worktree before feature research.
- Enforce one active feature per project in V1.

### 2. Retrieve context and plan

- External-interactions agent retrieves the Jira issue and design context.
- Select **Figma first, otherwise Stitch, otherwise Jira alone**. Figma and Stitch are mutually exclusive for a feature; never combine them silently.
- Jira remains the source of requirements and acceptance criteria. Ask about ambiguity or conflicts.
- Researcher inspects related code inside the worktree.
- Planner produces scope, acceptance criteria, approach, affected areas, and verification steps.
- Iterate with the human until the exact plan revision is explicitly approved.

### 3. Implement, review, and verify

- Implementer writes approved changes and tests.
- Reviewer performs code review, Gradle build, lint, unit tests, and Roborazzi screenshot tests.
- QA compares the running app with the selected designs and runs E2E with mocked backend responses.
- QA records video, takes screenshots, and captures tracking analytics evidence from Logcat. The existing private E2E framework understands the analytics events; its integration contract will be supplied later.
- Prefer a usable physical device; otherwise use an emulator. If selection or availability is uncertain, ask.
- Publish evidence to both Jira and the PR through the external-interactions agent. Jira can receive evidence before PR creation; PR publication follows creation.
- Present findings for human acceptance/discard. Run approved fixes and repeat affected verification.

### 4. Approve and publish

- Obtain explicit implementation approval bound to the current revision.
- External-interactions agent pushes that revision and opens the GitHub PR.
- Process subsequent PR feedback through the same individual/batch decision gates.
- Required checks may only be waived through explicit human override; represent waived status accurately.

### 5. Consolidate knowledge

A PR is ready to merge when CI passes, review threads are resolved, required approvals are granted, and there are no conflicts or other merge blockers.

At that point, ask which observed learnings should become confirmed rules in `AGENTS.md`. Approved consolidation belongs in the feature PR, with explicit approval of the resulting diff before pushing. Recheck readiness afterward because the new commit can invalidate checks or approvals.

Track which learnings were already considered to avoid repeated consolidation prompts for the same entries.

### 6. Merge and clean up

- A human explicitly merges the PR.
- Merge verification is **human-triggered**, not a background monitor.
- Once verified, automatically remove the feature worktree and local feature branch.
- Pause and ask if uncommitted or unpushed work exists. Do not infer merge completion solely from ancestry: GitHub may use squash/rebase merges.
- Preserve shared memory and local workflow records outside the removed worktree.

## Jira synchronization

Update the ticket at lifecycle transitions, including work started, verification, PR opened, and PR merged. Change states where supported by the project's Jira workflow.

Ask for the project's state mapping during setup and save it in local `MEMORY.md`. These lifecycle updates are pre-authorized. **Always ask on synchronization failure**; do not silently continue or invent a fallback state/comment policy.

Record completed external operations so interrupted work can reconcile actual remote state before retrying and avoid duplicate comments, uploads, or PRs.

## Memory and project configuration

- One canonical local `MEMORY.md` per project, outside worktrees, shared by all of that project's worktrees through the harness. No per-worktree copy is required.
- Operator serializes writes and deduplicates entries.
- Save observed facts: working commands, project settings, conventions, testing pitfalls, and useful feature learnings. Label source, scope, and confirmation status.
- Confirmed rules are consolidated into `AGENTS.md` only after human review at the end of the workflow.
- Always ask when `MEMORY.md`, `AGENTS.md`, or harness instructions conflict.
- Missing settings are clarified with the human and saved in `MEMORY.md`.
- Cross-machine feature state/memory synchronization is not required for V1.

## Build-artifact reuse

Operator maintains a manifest linking artifacts to their source snapshot, build variant, relevant configuration, and toolchain inputs. Account for uncommitted changes; a commit SHA alone is insufficient.

Reviewer and QA may reuse an artifact only when its provenance matches the current verification target. Relevant code/configuration changes invalidate reuse and affected results.

## Git and publication policy

| Content | Destination |
| --- | --- |
| Application code, tests, required Roborazzi baselines | Project Git history |
| Explicitly approved consolidated rules | Project `AGENTS.md` in Git |
| Plans, memory, approvals, workflow state, internal reports, execution logs | Local storage outside project Git |
| QA evidence and summaries | Jira and PR attachments/comments, not project Git history |
| Harness source, specification, reusable definitions, installation documentation | This harness repository |

No generated operational harness artifacts should be committed to application repositories. The exceptions above for tests/baselines and approved `AGENTS.md` changes are explicit.

## Implementation roadmap

1. **Enforcement prototype (in progress):** controller, revision-bound human controls, overrides, persistent state, single-feature lock, action boundaries, interruption recovery, and bypass tests. Next is the trusted host/agent IPC and interactive approval console; OpenCode tool filtering and host isolation remain proof obligations.
2. **Portable foundation:** global installation for Windows/macOS, explicit machine profiles, shared local project storage, worktree lifecycle.
3. **Agent workflow:** eight customizable agents, fixed models, planning, implementation, review/QA findings, and approval flows.
4. **External integrations:** Jira/GitHub/Figma/Stitch through one owner, state mapping, recoverable publication.
5. **Android verification:** Compose/Roborazzi, artifact reuse, physical-device-first selection, private E2E adapter, evidence capture and publication.
6. **Real-project pilot:** one Jira issue through human merge and cleanup, including interruption recovery and memory consolidation.

### Prototype acceptance checks

- Missing/stale approvals block protected actions.
- Agent-originated approval requests cannot impersonate human confirmations.
- Overrides apply only to their named step/revision; blanket approval is rejected.
- Enumerated finding batches cannot authorize findings added later.
- Shell, alternative tools, and child sessions cannot bypass protected action boundaries.
- Concurrent sessions cannot start a second feature for the same project in V1.
- Restart requires human-confirmed resume; interrupted external actions are reconciled before repetition.
- State corruption or uncertain approval state blocks progression and asks the human.
- Changes invalidate the correct approvals, verification results, and cached artifacts.
- Tests exercise real action boundaries, not just the controller's happy path.

## Add the harness to a new machine

### What works today

You can clone and run the experimental controller tests on either platform. There is not yet a runnable integrated harness or installer. Do not register a nonexistent plugin or assume that approvals are enforced after cloning.

### Prerequisites

1. Install Git, GitHub CLI (`gh`), OpenCode V2, and Node.js 24.x.
2. Authenticate GitHub CLI with an account that can access this private repository:

   ```text
   gh auth login
   gh auth status
   ```

3. Configure the machine's model connection through OpenCode: ChatGPT sign-in on Windows, or the appropriate LiteLLM connection on Mac. Never commit credentials.

### Windows (PowerShell)

```powershell
$destination = Join-Path $HOME 'Documents\Advanced Harness'
gh repo clone IkariMeister/advanced-harness "$destination"
Set-Location "$destination"
Get-Content README.md
```

### macOS (Terminal)

```sh
gh repo clone IkariMeister/advanced-harness "$HOME/Advanced Harness"
cd "$HOME/Advanced Harness"
cat README.md
```

For an existing clean clone, retrieve updates with `git pull --ff-only`.

### Prototype development (not a feature-workflow installer)

From the cloned repository, install locked dependencies and run unit tests/type checks:

```text
npm ci
npm test
npm run typecheck
```

Run the isolated interactive demo with `npm run demo`. It creates a disposable text fixture and local SQLite database in a temporary directory; it does not touch a real project or connect to external services.

The prototype snapshotter intentionally supports only small fixture directories, rejects `.git` and symlinks, and hashes every file. A real Android adapter must provide a trustworthy manifest of verification inputs, including relevant uncommitted source/configuration and excluding generated outputs. The current local approval surface is a host API, not an authenticated OpenCode UI.

### Activation checklist once implementation is available

The installer and exact commands will be added with milestone 2. Before relying on the adapter, run the live adversarial checklist in [`spike/opencode/README.md`](spike/opencode/README.md). The installer must:

1. Install a pinned harness version and register its OpenCode adapter globally, preserving existing configuration. OpenCode V2 global configuration is normally `~/.config/opencode/opencode.json(c)`.
2. Create machine-local provider/model mappings and project-data paths outside Git. On LiteLLM, require explicit deployment IDs rather than guessing aliases.
3. Validate every agent's fixed model/variant against the active account; pause on missing access.
4. Connect Jira, GitHub, and design MCP integrations for the external-interactions agent, using locally configured credentials.
5. Validate deterministic gates and agent boundaries on that machine before enabling feature execution.
6. Register an application project; read `AGENTS.md`, ask for missing settings and Jira mappings, and save answers in shared local `MEMORY.md`.
7. Verify Android SDK/JDK/Gradle prerequisites, Roborazzi commands, physical device or emulator availability, and the private E2E adapter.

Do not copy credentials, local feature state, approvals, logs, or evidence through this repository when setting up another machine.

## Open questions for implementation

- Private E2E framework API and evidence export contract.
- Exact Jira/GitHub/design MCP capabilities, especially binary evidence publication.
- LiteLLM endpoint, deployment IDs, and supported reasoning settings.
- Windows/macOS IPC implementation and adversarial proof that agents cannot reach the host channel, console input, or alternate execution routes.
- Portable runtime/version and packaging choices, to be validated during the prototype.

## References

- [OpenCode V2 configuration](https://opencode.ai/v2/docs/config)
- [OpenCode V2 plugin API](https://opencode.ai/v2/docs/build/plugins)

Documentation describes building blocks; it does not establish that this harness's enforcement is already implemented or validated.
