# OpenCode V2 approval-boundary spike

This spike investigates one narrow question: can the V2 server keep agent actions behind a controller while a separate, explicitly user-operated CLI UI approves the exact plan revision?

## Design tested against V2 APIs

1. **Server plugin (`server.ts`)** registers only three demo actions: status, propose a demo plan, and apply an in-memory demo action. It registers no approval tool.
2. A `session.context` hook filters the actual tool catalog on every model request using the OpenCode agent ID. Unknown agent IDs fail closed. Shell, edit/write/patch, Code Mode `execute`, and MCP tools are removed. Research roles retain read/glob/grep; only the lead retains subagent launch; role-specific harness tools are visible only where needed.
3. A `permission.evaluate` hook independently checks agent ownership for every `harness_*` action. Unknown future `harness_*` actions fail closed.
4. **CLI/TUI plugin (`tui.ts`)** contributes a user-invoked command-palette action. It displays the exact plan and SHA-256 revision in OpenCode's confirm dialog. Only the button callback submits the approval RPC.
5. The RPC challenge is random, single-use, expires after one minute, and binds approval to the exact plan digest. A new plan invalidates challenges and approval. The action checks the digest again immediately before applying.
6. The demo effect exists only in server memory; it does not edit project files or contact services.

The server agent permissions template is [`permissions.example.jsonc`](./permissions.example.jsonc). V2 permission rules are ordered, and the last matching rule wins. Configure a deny-by-default policy and only add the documented per-agent exceptions. Keep the server tool-catalog filter as defense in depth; permissions alone are not the gate.

For a disposable local test project, put the package directory under `.opencode/plugins/advanced-harness/` (OpenCode loads package directories there) or configure the package path in `opencode.jsonc`; merge the permission example into that test project's config. The package exports the V2 server entry at `.` and CLI entry at `./tui`. The server entry loaded successfully from a package directory in OpenCode 2.0.24. The CLI entry must be registered separately in the isolated CLI's `cli.json` or exposed as a TUI component through the server plugin; that client/UI loading has not yet been runtime-verified. Back up and merge existing config—do not replace it. See the [V2 plugin loading guide](https://opencode.ai/v2/docs/plugins/) and [CLI plugin guide](https://opencode.ai/v2/docs/cli/plugins/) for current path/config rules.

## What this proves—and does not

- **Proved by type-checking:** the server and TUI adapters type-check against the exact published `@opencode/plugin` 2.0.24 API, including plugin RPC, session hooks, permission hooks, and the CLI dialog/keymap APIs.
- **Unit-tested:** the pure tool-catalog role filter removes shell/MCP/Code Mode and rejects unknown roles; role ownership checks reject cross-agent harness actions; approval challenges expire, bind to a revision, and cannot be replayed. See root `test/opencode-spike.test.ts`.
- **Not runtime-proved:** this environment has no OpenCode executable (including WSL), so we have not validated actual tool permission action names, per-session context filtering behavior, subagent tool catalogs, or CLI/TUI-to-server RPC behavior in a live OpenCode 2.0.24 process. The `.jsonc` policy is a candidate configuration, not an integration test result.
- **Not a security boundary against the local user or arbitrary local processes:** plugin RPC is an HTTP-callable method. This design assumes agents cannot reach generic shell, POST/HTTP, Code Mode, or MCP tools. If any such path is available, an agent could invoke RPC outside the approval dialog. Do not use it to gate real edits, pushes, PRs, Jira, or other external actions until a live adversarial test confirms the agent's effective tool and API access.
- The TUI approval UI covers OpenCode CLI/TUI only. Desktop/web approval UI would need a client-specific adapter or another trusted human surface.
- The prototype challenge/state is in memory, has no durable recovery, and approves only a demo plan—not the production controller's complete plan/implementation/feedback decisions.

## Why the split matters

V2 server plugins can register agent tools and use session hooks to modify the model-call tool catalog. CLI plugins are a distinct client-side extension surface with user dialogs and keymap/palette commands. Plugin RPC lets the CLI surface call server-side code.

No approval method is exposed as a model tool. Agents cannot supply an “approved” flag. Approval originates in the CLI plugin's user confirmation callback and is checked server-side against a one-time revision-bound challenge. However, RPC does not establish a special human identity; the live test must prove the agent has no alternative route to call it.

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

The source was type-checked using TypeScript 7.0.2 against `@opencode/plugin` 2.0.24 plus the matching `@opentui`/Solid type packages in an isolated temporary directory. Those temporary validation dependencies are not part of the harness lockfile. The local role-filter unit tests run with the repository's `npm test` command.

## Live test status (OpenCode 2.0.24, Linux x64)

- Installed the CLI under `/tmp/advanced-harness-v2-spike` with a temporary `HOME` and `XDG_CONFIG_HOME`; no user/global OpenCode config was used.
- `opencode debug config` parsed the deny-by-default example. `opencode plugin list` plus the authenticated `/api/plugin` endpoint confirmed `advanced-harness.enforcement-spike` loaded as `active` with `server` and `rpc` features. A non-LLM request failed at the provider call (the isolated environment has no usable model credential), but the plugin loaded before that request.
- An authenticated direct HTTP request to `/api/rpc/advanced-harness-approval-spike/pending` successfully reached the RPC handler. This confirms the RPC is an ordinary callable server endpoint, not intrinsically a human-only channel. This request only read pending state; it did not grant approval.
- The end-to-end adversarial checklist remains **incomplete**: there is no usable model credential for agent tool-catalog/subagent invocation, and we have not launched an interactive TUI with the approval component. Consequently no claims are made about real model-call filtering, shell/MCP denial, agent RPC access, or human-only dialog approval. Treat the spike as **not production-safe** until those tests run and the RPC identity/bypass question is resolved.
