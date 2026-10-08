# Advanced Harness

An **OpenCode-native Android engineering workflow**: Lead coordinates specialized agents, you approve plans and publishing in the conversation, and agents use OpenCode's shell, Git, filesystem, and MCP tools.

## Current direction and status

The simplified direction was approved on 2026-10-08. There is **no separate harness host, approval terminal, custom IPC, approval-token system, or SQLite workflow engine in the product plan**. Shell, Git, and MCP integrations are required; screenshots, videos, and other evidence are useful but optional unless explicitly requested.

The workflow specification is in [`docs/opencode-native-workflow.md`](docs/opencode-native-workflow.md). Native agent templates are in [`agents/`](agents/README.md), with a merge-only configuration example in [`opencode.native.example.jsonc`](opencode.native.example.jsonc). An [interactive installer](docs/installation.md) now reads OpenCode JSON/JSONC config and asks for each role's model/variant before installing inline agent definitions at project/global scope. They are a starting point, not an end-to-end validated product. Cloning this repository does not activate agents or configure MCP connections. Model access validation, project setup, integrations, and a real Android pilot remain to be delivered.

**Approval is a conversational workflow rule followed by Lead, not an independently enforced security gate.** OpenCode permissions control tool access; they do not prove that a particular plan was approved. Shell runs with the user's authority, and shell command patterns are not a sandbox. Do not claim deterministic approval enforcement, cross-process isolation, or exactly-once external operations.

The existing enforcement controller, host console, adapter, and runtime probes are retained as **historical experiments** under `src/`, `examples/`, and `spike/opencode/`; the new native installer in `src/native-installer.ts` and `examples/install-native-harness.ts` is product tooling. Historical experiments are not the product foundation and must not be loaded alongside the native templates. Their tests still run; historical security proof obligations are not release prerequisites for the simplified workflow.

## Scope

- OpenCode V2 on Windows and macOS; product V1 means the first harness release, not OpenCode V1.
- Interactive project/global installation across projects, preserving unrelated OpenCode configuration.
- Customizable agents, explicit model/reasoning assignments, and machine-local provider mappings.
- One active feature per project as an operational convention; no custom locking service.
- Local memory shared across a project's worktrees; no cross-machine unfinished-state synchronization required.
- Initial stack: Android, Jetpack Compose, Gradle, Roborazzi, and the existing private E2E framework.
- Required integrations: Jira, GitHub, and Figma first, otherwise Stitch, otherwise Jira alone. Do not combine Figma and Stitch silently.
- Windows connection: ChatGPT sign-in in OpenCode. Mac connection: LiteLLM with explicit deployment mappings.
- Future concurrency, team sharing, and other agent hosts are deferred.

## Agents and fixed models

| Agent | Responsibility | OpenAI model | Reasoning |
| --- | --- | --- | --- |
| Lead | Coordinate the workflow, approvals, and progress | `openai/gpt-6-astra` | `medium` |
| Operator | Local Git, worktrees, shared memory, cleanup | `openai/gpt-5.3-codex-spark` | `low` |
| External | MCP, service APIs, remote Git, Jira, GitHub, design services | `openai/gpt-5.3-codex-spark` | `low` |
| Researcher | Inspect the codebase and relevant local context | `openai/gpt-6-luna` | `medium` |
| Planner | Prepare and revise the implementation plan | `openai/gpt-6.1-sol` | `medium` |
| Implementer | Write approved code, tests, and fixes | `openai/gpt-6-luna` | `low` |
| Reviewer | Code review, Gradle build/lint/tests, Roborazzi | `openai/gpt-6.1-sol` | `low` |
| QA | Runtime/design/E2E verification | `openai/gpt-6-luna` | `low` |

These assignments are preferences to validate against the active connection, not evidence of access. Spark was rejected by the tested ChatGPT connection. Setup must ask for an explicitly approved replacement or supported connection before Operator/External can be used; no silent fallback. LiteLLM endpoints, deployment IDs, and reasoning mappings must be supplied explicitly. Selecting a primary agent does not necessarily change the session's selected model; verify both.

## Human control in the Lead conversation

1. Lead presents the latest plan and **waits until you explicitly approve it**. For example: “I approve this plan.” No terminal token or separate approval UI is required.
2. Lead passes the approved scope and your decision to Implementer. Child agents cannot approve a plan themselves; a child's claim of approval is not a human decision.
3. A material scope/approach change returns to you for approval before more implementation. Ambiguous approval or competing plan versions require clarification.
4. Lead presents review/QA findings. You accept or discard findings individually or as a clearly listed batch; accepted fixes stay within their approved scope.
5. Lead presents verification results and asks for final approval before External pushes and opens the PR. New material changes after final approval require renewed approval.
6. Only a human merges. After you ask to verify the merge, Operator may clean up the feature worktree/branch once merged state is confirmed. Ask before handling uncommitted or unpushed work.
7. On interruption, Lead summarizes the current state and asks before resuming. Inspect Git/service state before retrying an uncertain external action; do not claim an automatic recovery engine.
8. Explicit conversational exceptions are allowed for specific steps. Mark waived checks as waived, never passed. Blanket “approve everything,” agent-generated approvals, and bypassing GitHub requirements are not supported.

Ordinary OpenCode tool-permission prompts may still appear for shell, filesystem, or MCP operations. They are not plan approval and need no separate terminal. Lead must still follow the conversational workflow even when a tool is allowed.

## Feature lifecycle

1. **Bootstrap:** Operator inspects the repository, `AGENTS.md`, base branch, and existing worktrees. Ask for missing/conflicting settings. Create a feature worktree under a visible location such as `$HOME/Projects` before feature changes; never discard unrelated work.
2. **Context:** External retrieves Jira requirements and the selected design source through MCP/API tools. Researcher inspects related code. Jira remains the source of acceptance criteria; ask on ambiguity.
3. **Plan:** Planner proposes scope, acceptance criteria, changes, tests, and affected areas. Lead presents the plan and waits for your conversational approval.
4. **Implement:** Implementer writes the approved changes and tests using native OpenCode tools. Report any material deviation instead of silently expanding scope.
5. **Review and verify:** Reviewer runs configured build/lint/unit/Roborazzi checks; QA checks runtime behavior, design, and configured E2E tests. Lead presents findings and obtains your fix/discard decisions; rerun affected checks after fixes.
6. **Publish:** Lead obtains final implementation approval. External pushes and opens the PR, updates Jira, and handles later feedback through the same finding/fix loop. Do not merge.
7. **Consolidate and clean up:** Ask which observed learnings should become confirmed `AGENTS.md` rules; approve resulting changes before publishing. After human merge and a human-triggered verification, Operator cleans up safely.

## Tool and integration ownership

- Only External owns MCP, web/service API access, remote Git, GitHub/Jira, and design services.
- Operator owns local Git/worktree operations and shared memory writes. Other agents request Git information from Operator instead of taking over the Git lifecycle.
- Implementer owns source/test changes; Reviewer and QA report findings rather than silently fixing application code.
- Reviewer/QA use project-specific shell/test/device commands. Build/test dependency resolution is allowed runtime infrastructure, not authorization for unrelated external-service operations.
- Lead delegates only to the seven named roles, not generic/explore fallbacks. Agents do not change models or grant themselves tools when a capability is missing.
- Tool policies and role instructions support workflow ownership, not protection from a hostile same-user process. Validate the effective configuration before a real pilot.

MCP authentication stays in OpenCode's credential stores. Configure actual server IDs/tool names and validate access; do not invent URLs or commit secrets. Jira lifecycle synchronization is pre-authorized once the project's state mapping is agreed. Ask on synchronization failures rather than silently continuing or guessing a fallback. Final approval authorizes pushing the approved work and creating the PR, not merging it.

## Verification and optional evidence

The plan names the required checks and project commands. Review, build, lint, unit tests, relevant Roborazzi coverage, and runtime/E2E checks remain workflow requirements where configured; missing commands or prerequisites require clarification or an explicit waiver.

Prefer a usable physical device, otherwise an emulator; ask when device selection is uncertain. The private E2E framework's invocation contract still needs to be supplied. Screenshot/video/logcat analytics capture and publication are **nice to have** by default. An evidence-capture failure does not block the feature unless you made that evidence an acceptance requirement; report what is missing.

Publish useful captured evidence to Jira and the PR through External when supported, without committing recordings or generated logs to application Git. Reuse clearly matching artifacts when practical, but a sophisticated artifact-manifest/cache system is deferred. Application tests, required Roborazzi baselines, and approved `AGENTS.md` changes belong in Git; local plans/memory/progress notes and optional operational evidence do not.

## Lightweight progress and memory

Lead maintains a conversation checklist: issue, feature/worktree, current plan and approval, implementation, checks, findings/decisions, final approval, publication, and cleanup. Before compaction/interruption, summarize unresolved decisions and observed results. If approval context is missing on resume, ask again; no custom database is required.

One canonical local `MEMORY.md` per project is shared across worktrees, for example under `$HOME/Projects/advanced-harness-data/<project>/`. Agree the path during setup and let Operator serialize updates. Label facts by source, scope, and confirmation; do not store credentials. Ask when memory, project instructions, or user directions conflict. Consider each learning once for approved consolidation into `AGENTS.md`.

## Delivery plan

1. **Specification and native templates:** simplify the product scope; conversational Lead approval instructions, role prompts, and native permission examples. Source templates now exist; runtime validation is pending.
2. **Installation and project setup:** an interactive merge-preserving project/global installer now assigns models per role. Real model-access validation, visible worktree/data paths, project commands, and shared memory setup remain.
3. **Required integrations:** configure Jira/GitHub/design MCP access and state mapping without exposing credentials; validate each role's required tools.
4. **Real Android pilot:** one issue through plan approval, changes, review/QA, approved fixes, PR creation, human merge, and cleanup. Test an interruption and ask-to-resume behavior.
5. **Optional improvements:** evidence capture/publication and practical artifact reuse, driven by pilot needs.

No IPC-hardening or forged-wrapper security campaign is required before delivering this instruction-driven workflow. Do not promote the historical prototype's security claims into the new product.

## Development and setup

Prerequisites: Git, OpenCode V2, Node.js 24.x, the required model connection, and GitHub/Jira/design access. GitHub CLI is useful for repository setup and External's approved GitHub operations.

```text
npm ci
npm run typecheck
npm test
```

These commands check repository code and template contracts; they do not install the harness, authenticate MCP, or prove agents follow approval instructions. To install deliberately, run `npm run harness:install` and review the [installation guide](docs/installation.md). The installer asks scope/destination and every agent's model/variant, preserves unrelated config, and writes only after confirmation. See [`agents/README.md`](agents/README.md) for the native starting point. Do not install historical spike plugins or copy credentials between machines.

Historical demos and probes remain available for comparison only; their separate-terminal approval requirement does not apply to the native workflow. See [`spike/opencode/README.md`](spike/opencode/README.md) and the superseded [`docs/host-controller-boundary.md`](docs/host-controller-boundary.md).

## Open setup questions

- A supported model/connection choice for Operator and External; explicit LiteLLM mappings on macOS.
- Project base branch, worktree/memory paths, Jira state mapping, and build/test/device commands.
- Actual MCP server IDs, authentication, design-source availability, and publication capabilities.
- Private E2E invocation contract and any evidence explicitly required for acceptance.

## OpenCode V2 references

- [Agents](https://opencode.ai/v2/docs/agents)
- [Permissions](https://opencode.ai/v2/docs/permissions)
- [MCP servers](https://opencode.ai/v2/docs/mcp-servers)
- [Configuration](https://opencode.ai/v2/docs/config)
