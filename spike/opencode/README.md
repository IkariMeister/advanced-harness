# OpenCode V2 approval-boundary spike

This directory contains two experiments. `rejected-rpc-server.ts`/`tui.ts` preserve the rejected plugin-RPC approval experiment. The package entrypoint `server.ts` re-exports `host-adapter.ts`: OpenCode tools call the separate host process over its role-bound local IPC. Human decisions stay in the host console (`src/host-console.ts`), not in OpenCode.

## Rejected: plugin-RPC approval design

The original `rejected-rpc-server.ts` and `tui.ts` registered a demo approval RPC. They are retained only for historical comparison. Do not configure them: authenticated local HTTP access to the RPC endpoint is not a human identity proof. The findings and runtime evidence are in the final section below.

## Host IPC adapter

`host-adapter.ts` registers only four agent tools: `harness_status`, `harness_action`, `harness_propose_plan`, and `harness_report_finding`. Their visibility is filtered per configured agent ID. The adapter selects an IPC endpoint from OpenCode's trusted tool execution context (`toolContext.agent`); role is not accepted as a model-supplied argument. The host controller still validates the action owner independently. There is no human decision tool and no plugin RPC registration.

`host-adapter.permissions.example.jsonc` shows a deny-by-default candidate config. It is not proof that OpenCode's effective permission/tool set enforces the policy. The package expects `directory` plugin options to match the host's IPC directory; if omitted, it uses the current user's `~/.advanced-harness/ipc` path. The package is a checkout prototype: the adapter imports host IPC code from this repository, so packaging/install layout must preserve or bundle those imports before use.

The host demo does **not** launch OpenCode or prove that the plugin context hook is applied to every model call, resumed session, or delegated agent. Actual OpenCode/model integration and role-bypass tests remain required.

## Historical rejected design

1. **Server plugin (`rejected-rpc-server.ts`)** registered three demo actions: status, propose a demo plan, and apply an in-memory demo action.
2. A `session.context` hook filters the actual tool catalog on every model request using the OpenCode agent ID. Unknown agent IDs fail closed. Shell, edit/write/patch, Code Mode `execute`, and MCP tools are removed. Research roles retain read/glob/grep; only the lead retains subagent launch; role-specific harness tools are visible only where needed.
3. A `permission.evaluate` hook independently checks agent ownership for every `harness_*` action. Unknown future `harness_*` actions fail closed.
4. **CLI/TUI plugin (`tui.ts`)** contributed a user-invoked command-palette action. It displayed the exact plan and SHA-256 revision in OpenCode's confirm dialog and submitted approval through plugin RPC. This approach is rejected.
5. The RPC challenge is random, single-use, expires after one minute, and binds approval to the exact plan digest. A new plan invalidates challenges and approval. The action checks the digest again immediately before applying.
6. The old demo effect existed only in server memory; it did not edit project files or contact services.

The rejected-RPC experiment's server agent permissions template is [`permissions.example.jsonc`](./permissions.example.jsonc). The accepted-direction candidate is [`host-adapter.permissions.example.jsonc`](./host-adapter.permissions.example.jsonc). V2 permission rules are ordered, and the last matching rule wins. Configure deny-by-default and only add per-agent exceptions. Keep the server tool-catalog filter and controller-side role checks as defense in depth; permissions alone are not the gate. Back up and merge existing config—do not replace it. See the [V2 plugin loading guide](https://opencode.ai/v2/docs/plugins/) for current package/path rules.

## What this proves—and does not

- **Proved by type-checking:** the host adapter type-checks against the published `@opencode/plugin` 2.0.24 API; the historical plugin-RPC server and CLI/TUI files also type-check.
- **Unit-tested:** the host adapter's role filter removes shell/MCP/Code Mode and approval tools, permits only lead delegation, fails closed for unknown roles, and matches the controller's role IDs. Host IPC tests verify role-bound actions, absent human controls, per-endpoint file mode on POSIX, and revision staleness. See `test/opencode-host-adapter.test.ts` and `test/host-boundary.test.ts`.
- **Not runtime-proved:** no model-backed OpenCode session has yet validated effective tool permissions, per-session context filtering, subagent catalogs, or the adapter-to-host IPC flow. The `.jsonc` policy is a candidate configuration, not proof of an integration boundary.
- **Not a security boundary against the local user or arbitrary local processes:** plugin RPC is an HTTP-callable method. This design assumes agents cannot reach generic shell, POST/HTTP, Code Mode, or MCP tools. If any such path is available, an agent could invoke RPC outside the approval dialog. Do not use it to gate real edits, pushes, PRs, Jira, or other external actions until a live adversarial test confirms the agent's effective tool and API access.
- The historical TUI approval UI covered OpenCode CLI/TUI only and is rejected as a trust boundary.
- The host console prototype currently approves plan revisions only; other decision types, durable recovery/reconciliation UI, and production action handlers are not integrated.

## Why the rejected plugin-RPC split failed

V2 server plugins can register agent tools and use session hooks to modify the model-call tool catalog. CLI plugins are a distinct client-side extension surface with user dialogs and keymap/palette commands. Plugin RPC lets the CLI surface call server-side code.

The old experiment exposed no approval method as a model tool, and agents could not supply an “approved” flag. Nevertheless, RPC did not establish a special human identity: an authenticated direct HTTP request reached the approval plugin RPC endpoint. That is why the accepted design keeps the controller's human API in its own process and out of the agent IPC channel.

## Runtime test required before relying on it

On a disposable OpenCode V2 2.0.24 setup with the server and CLI plugins loaded:

1. Confirm `harness_demo_propose` is available only to Planner; `harness_demo_apply` only to Implementer; and the CLI approval action is absent from every agent tool list.
2. Ask every role to invoke shell, `execute`, an MCP tool, another role's harness action, and the approval RPC directly. Verify the tool is absent or the server denies it.
3. Propose plan A, open the user approval dialog, and cancel. Verify apply remains blocked.
4. Approve plan A through the dialog. Verify apply succeeds once.
5. Propose plan B, reuse plan A's approval/challenge, and verify stale/replayed approval fails.
6. Attempt approval through an agent-visible path, child agent, shell, or another tool and verify every attempt fails.
7. Repeat from every supported client. Do not count a TUI-only pass as Desktop/Web support.

Record the OpenCode version, client, effective tool catalog per role, permission decisions, and results. A single live bypass is a failed spike and blocks building the production workflow on this mechanism.

## Local API validation performed

The OpenCode plugin source was type-checked using TypeScript 7.0.2 against `@opencode/plugin` 2.0.24 plus matching CLI UI packages in an isolated temporary directory. Those validation dependencies are not part of the harness lockfile. The repository unit suite runs with `npm test`.

## Live test status (OpenCode 2.0.24, Linux x64)

- Installed the CLI under `/tmp/advanced-harness-v2-spike` with a temporary `HOME` and `XDG_CONFIG_HOME`; no user/global OpenCode config was used.
- `opencode debug config` parsed the deny-by-default example. `opencode plugin list` plus the authenticated `/api/plugin` endpoint confirmed `advanced-harness.enforcement-spike` loaded as `active` with `server` and `rpc` features. A non-LLM request failed at the provider call (the isolated environment has no usable model credential), but the plugin loaded before that request.
- Separately, the host-adapter package entry loaded from a disposable `.opencode/plugins/advanced-harness/` package directory and was listed by OpenCode 2.0.24. The attempted model request again failed at provider authentication, so tool catalog construction and adapter-to-host calls were not exercised.
- An authenticated direct HTTP request to `/api/rpc/advanced-harness-approval-spike/pending` successfully reached the RPC handler. This confirms the RPC is an ordinary callable server endpoint, not intrinsically a human-only channel. This request only read pending state; it did not grant approval.
- The end-to-end adversarial checklist remains **incomplete**: there is no usable model credential for agent tool-catalog/subagent invocation, and we have not launched an interactive TUI with the approval component. Consequently no claims are made about real model-call filtering, shell/MCP denial, agent RPC access, or human-only dialog approval. Treat the spike as **not production-safe** until those tests run and the RPC identity/bypass question is resolved.
