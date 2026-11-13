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
| **pruning** | Proposing and applying end-of-task removals from `MEMORY.md` for candidates across three kinds: redundant (covered by `AGENTS.md` rules or personal rules), contradicted or superseded (contradicted by rules or superseded by newer entries), or obsolete (referencing nonexistent issues, branches, or files, verified via tri-state evidence). For each candidate, the human chooses one of four dispositions: promote (to `AGENTS.md`), personal ("Apply only to me" into `AGENTS.personal.md`), keep, or discard. Removal from `MEMORY.md` occurs upon approved promotion (to `AGENTS.md` or `AGENTS.personal.md`) or discard; promoted rules must be non-empty, single-line, at most 2000 characters, and free of secrets or machine-local paths. Keep marks the entry reviewed with its visible `reviewed-keep` marker and evidence key without removing it. Nothing is removed without explicit human disposition. | Age-based pruning, size limits, or automatic deletion. |
| **reviewed marker** | The visible `(reviewed-keep:<kind>:<evidenceKey>)` tag recorded in an entry's `confirmation` field when the human chooses to keep a pruning candidate. The `confirmation` field is the schema carrier; tags are deduplicated by kind and evidence key, case-preserved, and capped at 5 tags per entry (evicting the oldest tag first when full). It silences re-proposing that entry for that specific kind and evidence key, while allowing re-proposal if new evidence arises or if an older tag is evicted after a 6th distinct keep tag is added to the same entry. | Arbitrary text in confirmation. |
| **plan hash** | The SHA-256 digest computed over a memory pruning plan's full contents (candidates, dispositions, promoted rules, counts, retained entries with all four fields, baseline `AGENTS.md` hash, updated `AGENTS.md` text, and diff) and recomputed on apply to verify that the approved plan and `AGENTS.md` baseline have not changed before writing. | File baseline hash; Git commit hash. |
| **partial-failure receipt** | The structured record returned or attached to a pruning apply error reporting which files in the ordered multi-file sequence (`AGENTS.md`, `AGENTS.personal.md`, `MEMORY.md`) were written, their resulting read-back hashes, which step failed (`agents`, `personal`, or `memory`), and the failure cause, used by Operator and Lead to report state so the human can decide recovery. | Installer [receipt](#hosts-installation-and-permissions). |
| **tri-state evidence** | Verification result for external references (issues, branches, files) with outcomes `exists`, `missing`, or `unknown`. An issue, branch, or file is proposed as obsolete only upon a verified `missing` outcome; an error or `unknown` result is never proposed for removal. | Binary boolean exists check. |
| **personal rules** | Private, permanent per-user rules for one project stored in `AGENTS.personal.md` beside `MEMORY.md` in the project data directory (derived from `memoryPath`), never committed or copied into worktrees. Order of precedence: Current Human Decision > `AGENTS.md` > personal rules > `MEMORY.md`. | Shared `MEMORY.md` learnings; `AGENTS.md` project rules. |
| **project ID** | The name of a project's default shared locations, derived from its main checkout's path, so all worktrees of a repository share it and separate clones do not. | Backlog ID; repository name. |
| **canonical checkout** | A repository's primary working directory, the one that is not a task worktree. It receives only remote updates: read-only inspection and a fast-forward-only update of the base branch during task bootstrap. Edits, commits, merges, rebases, and branch switches happen in a [task worktree](#hosts-installation-and-permissions). Applies only where the project uses task worktrees. See [ADR-004](adr/0004-canonical-checkout-remote-updates-only.md). | [Task worktree](#hosts-installation-and-permissions). A harness checkout pinned to a release tag is not a project's canonical checkout for this rule (see [releasing](releasing.md)). |
| **task worktree** | An isolated linked Git worktree created under the configured `worktreeDirectory` for executing a specific task or issue, kept separate from the [canonical checkout](#hosts-installation-and-permissions). | [Canonical checkout](#hosts-installation-and-permissions). |
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
| **role-process mode** | The Codex install mode in which each child role runs as its own `codex exec` process from its Codex role profile, started by Lead through the role launcher with a host permission prompt for each launch (issue #45). It is the only mode `harness:install --host codex` uses, at global scope. | Shared-agents mode, where Codex custom agents share the Lead session's sandbox. |
| **plugin-provided MCP server** | An MCP server a Codex plugin supplies, with no `[mcp_servers.<name>]` table in `config.toml`. Role processes run with Codex plugins disabled (`--disable plugins`, issue #209), so these servers are not listed by the role launcher and not selectable for External. | An MCP server defined in `config.toml`, which External can use when it is selected at install. |
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
| **preflight policy** | Per-project preflight settings in `.harness/preflight.json` (configurable check enablement and severity, forbidden path globs, prod/test globs, gitlink coverage acknowledgements) and `.harness/preflight-allowlist.json` (justified exact path/rule secret exceptions). Always read from local `refs/remotes/origin/HEAD`, with or without `--base`; never from project context. | Project context; global defaults; changeset base. |
| **check severity** | The level a configurable check reports, `block` or `warn`, set by `checks.<id>.severity` in the preflight policy. It changes only `block` and `warn` results; `pass` and `inconclusive` are never changed. | Exit code; inconclusive. |
| **configurable check** | A built-in preflight check that the trusted policy may enable, disable, or re-severity: `path-policy` and `test-change`. | Fixed check; custom check (a caller-supplied check, which the policy never alters). |
| **fixed check** | A built-in preflight check the policy cannot disable or re-severity: `changeset`, `base-context`, `policy-integrity`, `policy`, `secret-scan`, `worktree-boundary`, and `acceptance-criteria`. `policy-integrity` always reports a changed policy file as a review blocker. | Configurable check. |
| **test-change check** | The configurable preflight check (BH-070) that warns when production files changed and no test file changed, using the trusted `prodGlobs` and `testGlobs`. It passes with a not-run note when those globs are not configured. | Prod/test globs (the settings it reads). |
| **policy result** | The fixed `policy` row of a preflight result. It names the policy source (file, trusted ref, and commit), disabled checks, severity overrides, forbidden-glob mode and count, and programmatic overrides, and warns when a recorded key is inert (for example, prod/test globs while `test-change` is disabled) or when test-change is configured but prodGlobs/testGlobs are not set. | Preflight policy (the settings themselves). |
| **prod/test globs** | `prodGlobs` and `testGlobs` in the preflight policy: given together, validated as glob arrays, and enforced by the **test-change check** (BH-070). They are inert while `test-change` is disabled. | Forbidden path glob. |
| **criteria file** | The JSON file `--criteria <file>` reads, shaped `{"items":[{"text": string, "done": boolean}]}`. The fixed `acceptance-criteria` check reports its done and pending items. A checked item is the human's recorded progress, not approval. | Acceptance criteria as requirements (RDD); approval. |
| **justified bypass** | The `--justify-no-tests "<text>"` option of `harness:preflight`. It turns a `test-change` block into a warning when one occurs, and records the text verbatim as a `bypass` entry with `applied` set only when it changed a block. It is evidence of a stated reason, not approval: `approved` still derives from check statuses. | Approval; check severity. |
| **forbidden path glob** | A glob `path-policy` blocks. The built-in list applies unless the policy adds to it (`add`) or replaces it (an array, or `replace`). | Prod/test glob; secret exception. |
| **acknowledged incomplete coverage** | A clean gitlink gap whose exact path and commit IDs match a trusted policy entry with a nonblank justification. It remains visibly incomplete; exit 0 is possible only when no findings or other gaps remain. | Complete scan; secret exception. |
| **secret exception** | A justified exact path/rule allowlist entry, optionally limited to one positive 1-based source line and one change origin, that suppresses that secret finding only. It never changes forbidden-path policy. | A forbidden-path override. |
| **scan origin** | The changeset source group for added text: `committed`, `staged`, `unstaged`, or `untracked`. A line-scoped secret exception must name its scan origin because line numbers are scoped to one origin. | Git branch or remote. |
| **inconclusive** | A preflight check status (exit code 2) meaning a git/tool call or check failed, project context resolution failed, an unavailable trusted ref in `base-context` when `--base` is omitted, an invalid or unloadable preflight policy (which makes only the policy-dependent checks inconclusive: `path-policy`, `secret-scan`, and `policy`), a Git failure while reading the trusted ref, an empty check list was provided, an invalid check status was returned, or duplicate check IDs were found. In `exitCodeFor`, `inconclusive` (exit 2) takes precedence over `block` (exit 1); when the trusted ref is missing and `--base` is omitted, `base-context` is inconclusive while `worktree-boundary` blocks, yielding overall exit 2. Never counted as a pass. | Blocked (exit 1); unverified. |
| **trusted ref** | The local `refs/remotes/origin/HEAD`, read without fetching. It is the sole source of the preflight policy, with or without `--base`, and preflight also uses it to verify project context (`baseBranch` and linked context target in `base-context` when `--base` is omitted, and `worktreeDirectory` in `worktree-boundary` on every run). | Base ref (the ref the changeset is measured against); project context. |
