# Native tools, Code Mode, and unavailable-tool reports

OpenCode exposes native tools such as `shell` separately from the catalog searched
inside `execute` (Code Mode). Native names may appear as `functions.shell` in the
model's interface. Git and `gh` are commands run through shell, not necessarily
dedicated catalog tools. Search only discovers the tools in its catalog; an empty
`search({query: "shell execute"})` result does **not** prove native shell is absent.

Tool permissions, registered tools, tools offered to a specific model request,
and successful execution are different evidence. `harness:doctor` checks agent/model
discovery and catalogs, not all offered tools or delegated execution. A CLI/auth
status check outside External does not validate that child's native shell.

Keep four report fields separate: **offered/visible** to this request, **configured**
allow/ask/deny policy (including project/session overlays and rule ordering),
**invoked/result** (only for an actual call), and **owner** responsible for that work.
Do not infer one field from another: ASK is not a denial, an allow rule does not
prove exposure, and one successful invocation says nothing conclusive about another
session or role. If there was no invocation and no captured offered-tool evidence,
availability is unverified.

Direct MCP actions and nested Code Mode actions are different execution routes.
An MCP alias/permission does not prove its server is enabled, authenticated, or
offering a usable tool; a Code Mode catalog result does not establish a direct MCP
action (or vice versa). Establish the actual offered route and inspect the corresponding
effective configuration. Do not guess server/tool identifiers or treat a wrapper as
evidence for a nested action.

## Triage without guessing

1. Record the affected session/parent IDs, role, location, service/version, and model
   including variant. Use runtime metadata when available; label unknowns unverified.
2. Check effective permissions, project overrides, and active plugins read-only.
   A configured ASK rule is not a permission denial or proof of callable exposure.
   Do not remove blanket denies or grant broad access based on a child's claim.
3. Distinguish these outcomes:
   - **No invocation, only a model claim or empty search:** availability unverified.
   - **Captured offered-tool list lacks shell:** evidence of missing exposure for
     that request, not proof of its cause or of absence in every session.
   - **Actual tool/permission error:** report it accurately without fabricating a call.
   - **Shell ran, command not found/auth failed:** execution exists; investigate the
     executable/authentication problem separately, without changing credentials.
4. If needed, propose one bounded read-only probe through the named owner. For
   External/gh, `gh --version` is a suitable execution probe after explicit approval.
   Use native shell only if actually exposed; never invent tool paths. Preserve ASK
   and approve only that exact command once, not an always/saved grant. A missing
   tool claim is not authorization for a restart, role/model substitution, or retries.
5. Compare a standalone session with a **real delegated child** using the same
   External model/permissions, and verify observed tool completion/exit status.
   A successful standalone run does not establish child execution. If child execution
   succeeds, do not change permissions merely to address an earlier unverified claim.
6. If the discrepancy persists, capture the actual offered tool **names** at context
   assembly and provider dispatch in an explicitly approved disposable location.
   Prefer available server evidence; historical session messages/logs may not retain
   tool definitions. Any temporary observer requires approval, must not mutate requests,
   and must not log prompts, schemas, arguments, headers, credentials, or bodies.
   Inspect both HTTP and WebSocket transport where applicable. Do not install an
    observer globally or in the application, or restart active work automatically.

Escalate by ownership: Operator handles local Git/worktrees/memory; External handles
MCP, services, and remote Git; Implementer handles approved source/tests; Reviewer
and QA report verification prerequisites to Lead; Lead obtains human decisions.
Report exact denial/error and its scope. If evidence is only a self-report, catalog
miss, or configuration rule, label availability unverified. Do not grant permissions,
switch roles/models, retry, or restart as a workaround. Permission prompts are tool
authorization, not plan approval.

Stop repeating self-report probes as proof. Record the evidence and uncertainty,
then propose the smallest next action. A version probe does not authenticate a
repository or authorize pushing, PR creation, merging, or application commands.
Inspect remote and local state read-only before retrying any uncertain publishing,
service mutation, or cleanup operation. Record verified completion without repeating
the write, or report observed state to Lead and wait for explicit human confirmation
before retrying.

## Source changes versus installed prompts

Editing `agents/lead.md` or `agents/external.md` does not update existing installed
inline agent systems. Applying reviewed prompt-only changes requires separate
consent and a preview/backup that preserves models, permission arrays, connection
settings, and unrelated fields. Do not reinstall every role just to deploy this
guidance; reinstallation can replace permission arrays. No live prompt update is
performed by tests or by reading this document.

## Regression scope

Default tests check prompt/guidance contracts without inference or live tool calls.
Live delegated smoke probes require explicit approval and are not part of `npm test`.
On OpenCode 2.0.26, an approved isolated diagnostic captured identical native tool
names (including `shell`) in standalone External and a Lead-delegated External child.
Both completed `gh --version` with an exact-command one-time ASK reply. The earlier
session-specific blocker was not reproduced; its cause remains unknown. See BH-009
in [the backlog](backlog.md) for evidence paths and remaining validation gaps.

References: [V2 tools](https://opencode.ai/v2/docs/tools),
[permissions](https://opencode.ai/v2/docs/permissions), and
[session request hooks](https://opencode.ai/v2/docs/build/plugins).
