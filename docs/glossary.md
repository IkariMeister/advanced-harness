# Glossary

This is the single place where Advanced Harness terms are defined. Other documents, ADRs, agent contracts, and issues use these meanings and link here instead of redefining terms. When a term is ambiguous, qualify it as shown below (for example, "review tier" rather than "tier").

To add or change a term, edit this file in the same change that first uses the new meaning. Meanings from other projects (for example Gentle-AI) are not this project's meanings unless this glossary says so.

## Methodology (ADR-003)

| Term | Meaning in this project | Not to be confused with |
| --- | --- | --- |
| **RDD** | Requirements-Driven Development: verifiable requirements and acceptance criteria are the controlling source of truth. See [ADR-003](adr/0003-multi-methodology-development-architecture.md#rdd--requirements-driven-development). | Receipt-Driven Development (a Gentle-AI concept). |
| **SDD** | Specification-Driven Development: an approved specification (interfaces, invariants, states) is the controlling source of truth. | — |
| **ODD** | Organic-Driven Development: the goal is fixed and the solution emerges through progressive refinement; each step is routed to direct execution or a bounded exploration spike, and ambiguity is resolved by interviewing the human. | Outcome-Driven Development. |
| **HYBRID** | One explicitly selected mode that composes other modes with stated boundaries, source-of-truth precedence, and conflict handling. | Ad hoc mixing of methods. |
| **methodology mode** | Which of RDD, SDD, ODD, or HYBRID governs a work unit. | Rigor. |
| **rigor** | `minimal`, `standard`, or `strict`: how much planning, evidence, review, and approval a work unit needs. Chosen independently of the methodology mode; it sets a minimum review tier. | Review tier, model tier. |
| **work unit** | The scope a methodology mode and rigor apply to: a project, a requirement group, or a task. | Install scope. |
| **selection scope** | The level at which a mode or rigor is chosen (project, requirement group, task). The narrowest clearly bounded scope governs. | Install scope; review scope. |

## Roles and agents

| Term | Meaning in this project | Not to be confused with |
| --- | --- | --- |
| **role** | A logical responsibility with a contract in [`agents/`](../agents/README.md): Lead, Operator, External, Researcher, Planner, Implementer, Reviewer, QA. | An installed agent file on a given host. |
| **agent** | A role compiled and installed for a specific host (for example `.claude/agents/reviewer.md`). | Role. |
| **eight-role setup** | The current default set of the eight roles above. It stays the baseline during the ADR-002 evaluation. | — |
| **Engineer** | ADR-002's consolidated role combining Researcher and Implementer. During the pilot it is installed alongside them, never instead of them. | Implementer. |
| **Operations** | ADR-002's consolidated role combining Operator and External. Installed alongside them only where local/external isolation is enforced. | Operator. |
| **role setup** | Which roles a host has installed: the eight-role setup, optionally plus pilot roles such as Engineer or Operations. | Codex profile; legacy profile. |

## Skills and commands

| Term | Meaning in this project | Not to be confused with |
| --- | --- | --- |
| **workflow command** | One of the human-invoked task workflows in [`commands/`](../commands/README.md) (`/start-issue`, `/review-pr`, `/address-pr-feedback`, `/report-defect`, `/assess-debt`, `/grill-me`, `/document-agents`). Some hosts emit them as `SKILL.md` files; they are still workflow commands. | Procedure skill. |
| **procedure skill** | A reusable, host-neutral procedure (from canonical `skills/`, BH-045) that roles invoke, such as `documentation-impact` or a validation skill. It grants no permissions and makes no decisions. | Workflow command emitted as `SKILL.md`. |
| **validation skill** | A procedure skill describing a reproducible check (tests, static analysis, builds) and where its evidence goes. It does not decide whether results are acceptable. | QA role. |

## Review

| Term | Meaning in this project | Not to be confused with |
| --- | --- | --- |
| **review tier** | Reviewer's risk tier for a diff: Low, Medium, or High (see [`agents/reviewer.md`](../agents/reviewer.md)). | Model tier; rigor. |
| **lens** | One of Reviewer's four specialized review lenses: Risk, Resilience, Readability, Reliability (the "4R" lenses). | — |
| **evidence** | Recorded commands, exit status, output, and artifacts that show what was actually run. A passing command is evidence about that command, not acceptance. | Author's explanation. |
| **re-run / judged from evidence** | Whether Reviewer re-ran a check itself or assessed it from recorded evidence only. Review reports state which applies to each check. | — |

## Hosts, installation and permissions

| Term | Meaning in this project | Not to be confused with |
| --- | --- | --- |
| **host** | A supported agent environment: OpenCode, Claude Code, Antigravity, Codex, Cursor, and (planned) Pi. | Machine. |
| **install scope** | Where an install writes: `project` or `global`. | Selection scope; review scope. |
| **receipt** | The private installer record of what an install or update changed, used for update, uninstall, and recovery. | Gentle-AI "receipts". |
| **harness block** | The marker-delimited section an install owns inside a shared instruction file: the Lead block in `CLAUDE.md` or the model-preference block in a project context file. Uninstall removes only this block when other content in the file changed. | Marked `project`, `integrations`, or `paths` context sections, which an install does not own. |
| **project context** | Project-specific settings in the application's `AGENTS.md`, shared across hosts (see [configuration](configuration.md)). | Global connections; an agent's reasoning context. |
| **shared locations** | A project's task worktree parent (`worktreeDirectory`) and shared `MEMORY.md` (`memoryPath`), read from project context by every role and host (see [how shared locations resolve](project-setup.md#how-shared-locations-resolve)). | Host-managed worktree or memory locations. |
| **project ID** | The name of a project's default shared locations, derived from its main checkout's path, so all worktrees of a repository share it and separate clones do not. | Backlog ID; repository name. |
| **canonical checkout** | A repository's primary working directory, the one that is not a task worktree. It receives only remote updates: read-only inspection and a fast-forward-only update of the base branch during task bootstrap. Edits, commits, merges, rebases, and branch switches happen in a task worktree. Applies only where the project uses task worktrees. See [ADR-004](adr/0004-canonical-checkout-remote-updates-only.md). | Task worktree. A harness checkout pinned to a release tag is not a project's canonical checkout for this rule (see [releasing](releasing.md)). |
| **base branch** | The project's configured base branch, `baseBranch` in project context, written `<base>` in workflow text. It is not the current branch. | Current branch. |
| **dirty** | Any staged, unstaged, or untracked change, as `git status` reports. Used for the canonical checkout stop condition. | Committed but unpushed work. |
| **mid-operation** | A merge, rebase, cherry-pick, revert, or similar Git operation in progress. Used for the canonical checkout stop condition. | Dirty; a dirty checkout may have no operation in progress. |
| **portable path** | A saved location written as `$HOME/...`, which each machine resolves to its own home directory. | An absolute, machine-specific path. |
| **global connections** | Reusable, machine-level connections and defaults (MCP servers, preferences) shared across projects. | Project context. |
| **global project defaults** | Machine-level suggestions for project setup and `harness:update`: base branch, shell, checks, device preference, and worktree/memory parent directories. They are host-neutral and only ever suggest values; saved project context decides. | Global connections; project context. |
| **legacy profile** | A pre-context project configuration that may only be migrated with explicit consent. | Codex profile; role setup. |
| **legacy permission evidence** | A role's OpenCode permission array recorded by a pre-v2 (v1) receipt as one opaque field: no rule in it is attributed to the harness. | Owned rules; legacy profile. |
| **legacy permission migration** | The consented `harness:update` step (type `migrate`) that records the current legacy permission array as its legacy state and replaces legacy-installer rules the current policy changes. | Legacy profile migration; uninstall. |
| **Codex profile** | A named set of Codex settings layered over the base configuration. Codex supports two representations: a `[profiles.<name>]` table inside `config.toml`, and a standalone `$CODEX_HOME/<name>.config.toml` file selected with `codex -p <name>`. The harness writes only the standalone form, as a **Codex role profile**. | Role setup; legacy profile; Codex custom agent. |
| **Codex role profile** | A standalone `~/.codex/harness-<role>.config.toml` written for one child role in **role-process mode**: that role's sandbox, approval policy, network access, model, effort and instructions. The role launcher re-applies its settings on every launch and resume. | A `[profiles.<role>]` table; a Codex custom agent (`agents/<role>.toml`), which inherits the parent session's sandbox, approval and MCP settings. |
| **role-process mode** | The Codex install mode in which each child role runs as its own `codex exec` process from its Codex role profile, started by Lead through the role launcher with a human approval for each launch (issue #45). It is the only mode `harness:install --host codex` uses, at global scope. | Shared-agents mode, where Codex custom agents share the Lead session's sandbox. |
| **model tier** | The capability class assigned to a role (economical, mid-tier, strong, frontier). It is a tier, not a provider model ID. | Review tier; `reasoningTier`. |
| **`reasoningTier`** | A host preset field for reasoning effort (for example `low`). | Model tier; review tier. |
| **enforced** | The host itself prevents the action, verified by evidence. | Advisory. |
| **advisory** | Expressed in prompt text or configuration the host does not enforce. Not a security boundary. | Enforced. |
| **unsupported** | The host cannot express the boundary at all. | Unverified. |
| **unverified** | Not yet shown either way. Never reported as enforced. | Unsupported. |
| **fail closed** | When something is gated, unsupported, or ambiguous, stop before writing anything rather than proceeding with weaker behavior. | — |

## Workflow and tracking

| Term | Meaning in this project | Not to be confused with |
| --- | --- | --- |
| **Lead status states** | Working, Checking, Ready, Needs your decision (see [`agents/lead.md`](../agents/lead.md)). | GitHub issue state. |
| **approval** | An explicit human decision in the conversation. A conversational workflow rule, not an enforced security gate. | Host permission. |
| **ADR status** | Proposed, Accepted, Rejected, or Superseded by ADR-NNN (see the [ADR lifecycle](adr/README.md#status-lifecycle)). A Proposed ADR does not authorize implementation. | Issue status. |
| **ADR acceptance** | The human's approval that makes an ADR's decision the project's direction, recorded in the ADR header and index. It changes no tooling, roles, or defaults and authorizes no implementation. | Plan approval. |
| **Backlog ID** | Stable `BH-NNN` identifier of a backlog item, kept across issue edits. | GitHub issue number. |
| **milestone** | A GitHub milestone grouping planned work. Milestones are re-planned after each one closes, so issues reference work by Backlog ID or issue number, not milestone name. | Release. |
| **release** | A tagged version (`vX.Y.Z`) published through the [release process](releasing.md). | Milestone. |
| **preflight** | The pre-publish evidence run of `harness:preflight` over a task worktree (see [preflight](preflight.md)). It reports evidence only and never counts as approval. | Approval; Claude permission preflight; multi-file write preflight. |
| **changeset** | The files preflight inspects: `merge-base(base, HEAD)...HEAD` plus staged, unstaged, and untracked files, with contents. | A single commit; a PR diff. |
| **inconclusive** | A preflight check status (exit code 2) meaning a git/tool call or check failed. Never counted as a pass. | Blocked (exit 1); unverified. |
