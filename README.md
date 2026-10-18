# Advanced Harness

An **OpenCode-native Android engineering workflow**: Lead coordinates specialized agents, you approve plans and publishing in the conversation, and agents use OpenCode's shell, Git, filesystem, and MCP tools.

## Current direction and status

The simplified direction was approved on 2026-10-08. There is **no separate harness host, approval terminal, custom IPC, approval-token system, or SQLite workflow engine in the product plan**. Shell, Git, and MCP integrations are required; screenshots, videos, and other evidence are useful but optional unless explicitly requested.

The macOS preparation/validation checklist (manual prerequisites, isolated setup steps, expected outcomes, and failure handling) is in [`docs/macos-validation.md`](docs/macos-validation.md). It does not replace the separately approved live model/service pilot.

The workflow specification is in [`docs/opencode-native-workflow.md`](docs/opencode-native-workflow.md). Native agent templates are in [`agents/`](agents/README.md). The [interactive installer, diagnostics, and receipt-backed uninstall/adoption workflow](docs/installation.md), [context-only project setup](docs/project-setup.md), and [optional global connections/project selections](docs/configuration.md) are implemented locally with automated tests. Uninstall/adoption still needs the documented isolated interactive QA; it is not validated for live cleanup. Cloning this repository does not activate agents or configure MCP connections. Machine-specific model/service access, live setup migration, broader role permissions, and the full publishing/merge/cleanup lifecycle still need validation; see [GitHub issues](https://github.com/IkariMeister/advanced-harness/issues).

Six native project commands implement the human-approved task workflows in [task workflows](docs/task-workflows.md): `/start-issue`, `/review-pr`, `/address-pr-feedback`, `/report-defect`, `/assess-debt`, and `/grill-me`. Command Markdown is a prompt template, not an independently enforced approval gate. Arguments provide context, never approval. Project commands/arguments override global commands with the same names.

**Approval is a conversational workflow rule followed by Lead, not an independently enforced security gate.** OpenCode permissions control tool access; they do not prove that a particular plan was approved. Shell runs with the user's authority, and shell command patterns are not a sandbox. Do not claim deterministic approval enforcement, cross-process isolation, or exactly-once external operations.

The TypeScript code covers native installation, diagnostics, project-context setup, and optional integration tooling, with automated regression tests. The obsolete approval controller, host/IPC system, integration spike, demos, and prototype tests have been removed; they remain available in Git history only. Once installed, agents run through OpenCode without a custom harness service.

## Scope

- Multi-host foundation across 5 hosts: OpenCode V2, Claude Code, Google Antigravity, OpenAI Codex, and Cursor IDE (`--host <opencode|claude-code|antigravity|codex|cursor|all>`).
- Interactive project/global installation across projects, preserving host-neutral `AGENTS.md` and enabling coexistence without hosts clobbering each other.
- Customizable agents, explicit model/reasoning assignments, and machine-local provider mappings.
- Host-scoped V2 receipts, backups, and uninstall tracking footprint per `(target, host)`.
- One active feature per project as an operational convention; no custom locking service.
- Local memory shared across a project's worktrees; no cross-machine unfinished-state synchronization required.
- Initial stack: Android, Jetpack Compose, Gradle, Roborazzi, and the existing private E2E framework.
- Reusable integrations are configured globally; each project may independently select GitHub CLI/MCP, Jira, one design source, or none. Missing services are raised only when a task needs them. Do not combine Figma and Stitch silently.
- Windows connection: ChatGPT sign-in in OpenCode. Mac connection: LiteLLM with explicit deployment mappings.
- Future team sharing and remote synchronization are deferred.

## Agents and fixed per-host model presets

The 8-role engineering workflow provides fixed default role and model presets tailored for each host:

| Host | Lead | Operator / External | Researcher / Implementer / QA | Planner / Reviewer |
| --- | --- | --- | --- | --- |
| **OpenCode V2** | `openai/gpt-6-astra` (`medium`) | `openai/gpt-5.3-codex-spark` (`low`) | `openai/gpt-6-luna` | `openai/gpt-6.1-sol` |
| **Claude Code** | `sonnet` | `haiku` | `sonnet` | `opus` |
| **Antigravity** | `inherit` (session model) | `flash_lite` | `flash` | `pro` |
| **OpenAI Codex**| `openai/gpt-6-astra` | `openai/gpt-5.3-codex-spark` | `openai/gpt-6-luna` | `openai/gpt-6.1-sol` |
| **Cursor IDE**  | `standard` | `fast` | `standard` | `high-reasoning` |

All hosts enforce the explicit guard preventing any agent from executing `gh pr merge` / `gh.exe pr merge`. Runtime diagnostics (`npm run harness:doctor`) report health, configuration footprint, and host-specific capability/permission disclosures.

These assignments are preferences to validate against the active connection, not evidence of access. Spark was rejected by the tested ChatGPT connection. Setup must ask for an explicitly approved replacement or supported connection before Operator/External can be used; no silent fallback. LiteLLM endpoints, deployment IDs, and reasoning mappings must be supplied explicitly. Selecting a primary agent does not necessarily change the session's selected model; verify both.

## Human control in the Lead conversation

1. Lead presents the latest plan and **waits until you explicitly approve it**. For example: “I approve this plan.” No terminal token or separate approval UI is required.
2. Lead passes the approved scope and your decision to Implementer. Child agents cannot approve a plan themselves; a child's claim of approval is not a human decision.
3. A material scope/approach change returns to you for approval before more implementation. Ambiguous approval or competing plan versions require clarification.
4. Lead presents review/QA findings. You accept or discard findings individually or as a clearly listed batch; accepted fixes stay within their approved scope.
5. Lead presents verification results and asks for final approval before External pushes and opens the PR. New material changes after final approval require renewed approval.
6. Only a human merges. Your confirmation that the PR is merged triggers External to verify the merge and authorizes Operator to clean up the task worktree and local feature branch after safety checks. Preserve the remote branch; stop and ask if work is dirty, unpushed, or anything is uncertain.
7. On interruption, compaction, or lost context, preserve existing local/remote work untouched; Lead summarizes actual state in a checklist, marks missing approvals unconfirmed, and asks before resuming. Inspect Git/service state read-only before retrying an uncertain mutation: record verified completion without repeating the write, or ask before retrying incomplete/diverged state; do not claim an automatic recovery engine or workflow database.
8. Explicit conversational exceptions are allowed for specific steps. Mark waived checks as waived, never passed. Blanket “approve everything,” agent-generated approvals, and bypassing GitHub requirements are not supported.

Ordinary OpenCode tool-permission prompts may still appear for shell, filesystem, or MCP operations. They are not plan approval and need no separate terminal. Lead must still follow the conversational workflow even when a tool is allowed.

## Feature lifecycle

1. **Bootstrap:** Operator inspects the repository, `AGENTS.md`, base branch, and existing worktrees. Ask for missing/conflicting settings. Create a feature worktree under a visible location such as `$HOME/Projects` before feature changes; never discard unrelated work.
2. **Context:** Read project instructions and task acceptance criteria. External retrieves context only from explicitly selected services; when Jira is not selected, use project/task acceptance criteria. Researcher inspects related code. Ask on ambiguity; never silently enable or substitute Jira/design services.
3. **Plan:** Planner proposes scope, acceptance criteria, changes, tests, and affected areas. Lead presents the plan and waits for your conversational approval.
4. **Implement:** Implementer writes the approved changes and tests using native OpenCode tools. Report any material deviation instead of silently expanding scope.
5. **Review and verify:** Reviewer runs configured build/lint/unit/Roborazzi checks; QA checks runtime behavior, design, and configured E2E tests. Lead presents findings and obtains your fix/discard decisions; rerun affected checks after fixes.
6. **Publish:** Lead obtains final implementation approval. External pushes and opens the PR through the selected GitHub backend, updates Jira only when selected and authorized, and handles later feedback through the same finding/fix loop. Ask when the requested publishing task needs an absent integration. Do not merge.
7. **Consolidate and clean up:** Ask which observed learnings should become confirmed `AGENTS.md` rules; approve resulting changes before publishing. A human's merge confirmation triggers External's merge verification and authorizes Operator, after safety checks, to remove the task worktree and local feature branch. Preserve the remote branch and stop on dirty/unpushed work or uncertainty.

## Tool and integration ownership

- Only External owns MCP, web/service API access, remote Git, GitHub/Jira, and design services.
- Operator owns local Git/worktree operations and shared memory writes. Other agents request Git information from Operator instead of taking over the Git lifecycle.
- Implementer owns source/test changes; Reviewer and QA report findings rather than silently fixing application code.
- Reviewer/QA use project-specific shell/test/device commands. Build/test dependency resolution is allowed runtime infrastructure, not authorization for unrelated external-service operations.
- Lead delegates only to the seven named roles, not generic/explore fallbacks. Agents do not change models or grant themselves tools when a capability is missing.
- Tool policies and role instructions support workflow ownership, not protection from a hostile same-user process. Validate the effective configuration before a real pilot.

MCP authentication stays in OpenCode's credential stores. Configure selected services' actual server IDs/tool names and validate access; do not invent URLs or commit secrets. Jira lifecycle synchronization is pre-authorized only when Jira is selected and the human approves its state mapping and update scope. Ask on synchronization failures rather than silently continuing or guessing a fallback. Final approval authorizes pushing the approved work and creating the PR, not merging it.

## Verification and optional evidence

The plan names the required checks and project commands. Review, build, lint, unit tests, relevant Roborazzi coverage, and runtime/E2E checks remain workflow requirements where configured; missing commands or prerequisites require clarification or an explicit waiver.

Prefer a usable physical device, otherwise an emulator; ask when device selection is uncertain. The private E2E framework's invocation contract still needs to be supplied. Screenshot/video/logcat analytics capture and publication are **nice to have** by default. An evidence-capture failure does not block the feature unless you made that evidence an acceptance requirement; report what is missing.

Publish useful captured evidence to Jira and the PR through External when supported, without committing recordings or generated logs to application Git. Reuse clearly matching artifacts when practical, but a sophisticated artifact-manifest/cache system is deferred. Application tests, required Roborazzi baselines, and approved `AGENTS.md` changes belong in Git; local plans/memory/progress notes and optional operational evidence do not.

## Lightweight progress and memory

Lead maintains a conversation checklist: issue, feature/worktree, current plan and approval, implementation, checks, findings/decisions, final approval, publication, and cleanup. Before compaction/interruption, summarize unresolved decisions and observed results. If approval context is missing on resume, ask again; no custom database is required.

One canonical local `MEMORY.md` per project is shared across worktrees, for example under `$HOME/Projects/advanced-harness-data/<project>/MEMORY.md`. Agree the path during setup and let Operator serialize updates using baseline verification, label facts by source, scope, and confirmation, deduplicate identical entries, and reject secrets or operational log dumps. Order of precedence is **Current Human Decision > `AGENTS.md` > `MEMORY.md`**; surface conflicting facts or rule contradictions to the human via Lead rather than silently overwriting. Candidate learnings are considered once for approved consolidation into `AGENTS.md` via explicit diff review and approval before publication, preserving embedded harness settings and rejecting machine-local paths. Task bootstrap creates the isolated feature worktree under `worktreeDirectory` and initializes `MEMORY.md` without blocking on other existing worktrees or untouched canonical changes.

## Delivery plan

All known pending work, validation gaps, deferred features, and tracking
states are tracked in [GitHub issues](https://github.com/IkariMeister/advanced-harness/issues). Start there when resuming;
entries do not authorize implementation or replace current human approvals.

1. **Specification and native templates:** conversational Lead approvals, eight role prompts, and native permission examples are implemented. Discovery/model catalogs and a captured delegated shell smoke have passed in the tested installation; broader role/tool behavior remains unverified. Source prompt changes are not automatically deployed.
2. **Installation and project setup:** the installer assigns models and checks runtime discovery/catalogs; `harness:doctor` checks an existing installation. `harness:setup` records Android commands/device/shared paths only in AGENTS.md or explicitly referenced project context. Command/device validation and machine-specific model access still need a pilot.
3. **Optional integrations:** `harness:integrations --scope global` manages reusable connections/permissions and global defaults. Project scope records optional selections, repository/Jira identifiers and mappings only in context. GitHub, Jira, and design can each be none. New servers stay disabled; checks require separate approval. Real authentication/tool access and publishing validation remain.
4. **Real Android pilot:** one issue through plan approval, changes, review/QA, approved fixes, PR creation, human merge, and cleanup. Test an interruption and ask-to-resume behavior.
5. **Optional improvements:** evidence capture/publication and practical artifact reuse, driven by pilot needs.

This instruction-driven workflow does not provide an independent approval-enforcement layer.

## Development and setup

Prerequisites: Git, OpenCode V2, Node.js 24.x, and the required model connection. Service access is needed only for integrations selected for the task. GitHub CLI is needed when GitHub's `gh` backend is selected; Jira/design access is not a general setup prerequisite.

```text
npm ci
npm run typecheck
npm test
```

Check an installed harness without reinstalling:

```text
npm run harness:doctor -- --project "path/to/android-project"
```

This verifies agent visibility/modes and model/variant catalog availability, not account entitlement. It may start OpenCode's service but never restarts it or sends model requests. See [installation troubleshooting](docs/installation.md#after-installation).

Check for updates and preview changes to installed prompts and permissions:

```text
npm run harness:update -- --project "path/to/android-project"
```

This compares the local checkout and installed version stamp, checks remote `origin/main` on approval, previews per-role prompt diffs, preserves customizations, and records recovery receipts. See [safe harness update workflow](docs/installation.md#safe-harness-update-workflow).

Configure an Android project interactively:

```text
npm run harness:setup -- --project "path/to/android-checkout"
```

Setup records confirmed commands/device/paths without executing them or creating worktrees. Missing checks stay unconfigured, not waived. It writes settings into a marked `AGENTS.md` section, or a Markdown context file selected with `--context`, only after confirmation. Existing legacy JSON profiles are preserved and offered as suggestions only with explicit migration consent. See [project setup](docs/project-setup.md).

Configure reusable optional connections/defaults globally, then project choices in context:

```text
npm run harness:integrations -- --scope global
npm run harness:integrations -- --scope project --project "path/to/android-checkout"
```

Choose `gh`, MCP, or none for GitHub; Jira and design MCP are individually optional. Reuse existing global servers or supply real endpoints. Project scope writes no OpenCode config or separate profiles. `--check` checks selected connection/auth status—not service access; all-none makes no runtime calls. See [global connections and project context](docs/configuration.md).

These commands check repository code and template contracts; they do not install the harness, authenticate MCP, or prove agents follow approval instructions. To install deliberately, run `npm run harness:install` and review the [installation guide](docs/installation.md). The installer asks scope/destination and every agent's model/variant, preserves unrelated config, and writes only after confirmation. See [`agents/README.md`](agents/README.md) for the native starting point. Do not copy credentials between machines.

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

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.

