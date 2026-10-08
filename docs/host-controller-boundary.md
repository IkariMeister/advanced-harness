# Historical decision: keep human approval outside OpenCode

**Status:** superseded on 2026-10-08 by the approved [OpenCode-native conversational workflow](opencode-native-workflow.md). Retained as historical prototype documentation, not the product plan. The native workflow requires shell/Git/MCP and accepts human approval in the Lead conversation; none of this document's separate-host requirements apply to it.

## Decision

The workflow controller and approval UI will run in a trusted host-owned process outside the OpenCode server/plugin process. OpenCode receives only role-bound agent operations. There is no agent-callable `decide`, `approve`, `override`, `resume`, or `reconcile` endpoint.

The first human surface will be an interactive host console/terminal owned by the controller process. It reads current state directly from the controller, displays the exact gate, plan/findings, and revision digest, then collects an explicit interactive human choice. No approval is accepted from model text, tool arguments, OpenCode plugin RPC, or an approval-shaped HTTP request.

## Process and data flow

```text
OpenCode server/plugin
   └── role-scoped agent adapter ──> local agent-operation channel ──> controller
                                                                       ├── state DB
                                                                       ├── trusted action handlers
                                                                       └── interactive human console
                                                                           (local TTY only)
```

- The controller owns the database, project lock, checkout snapshots, action executors, and gate evaluation.
- The OpenCode adapter may request an operation as its assigned role and read limited status. It cannot choose another role/session, choose arbitrary executors, alter state, or decide a human gate.
- Role identity is assigned by the trusted adapter/controller binding, not accepted from arbitrary request payloads. Agent operations are validated against the protocol and controller role/action map.
- Human decisions are collected only by the controller's interactive console while it has a real TTY. The controller constructs the decision itself after displaying the exact current revision. Any updated revision returns to a fresh prompt.
- The controller's human API remains an in-process object. It is never serialized into the OpenCode agent adapter, plugin RPC registry, generic local HTTP API, or command-line flags such as `--approve`.
- State remains outside the worktree and is not shared with feature Git history.

## Local transport

The prototype transport is a local IPC channel: a Unix-domain socket on macOS and a named pipe on Windows. It does not bind TCP. A per-directory exclusive lock prevents two host instances from claiming the same IPC namespace. Unix socket directories/files are created with owner-only permissions (0700/0600). The Windows pipe ACL is not hardened or validated yet. The endpoint map is currently returned to the trusted host caller; a production adapter must receive only the specific role capability it needs. The channel carries only the constrained agent protocol; it has no generic RPC dispatch and no human-decision method.

OS-local IPC access control prevents unrelated users/processes from casually attaching; it does **not** prove that a caller is human. The current prototype has no per-client secret or caller authentication: any same-user process able to reach the socket/pipe can choose an endpoint and invoke that role's restricted surface. The trust boundary still depends on OpenCode agent sessions receiving no shell, arbitrary HTTP, raw IPC, unrestricted MCP/Code Mode, or alternate process-launch path to reach the controller or drive the human console. A generic executor tool must not be provided. If any such capability is available, assume a hostile agent can attempt to reach every local resource available to that process.

For V1, run the controller and its human console in the same process so the approval path is not a second network API. A local OpenCode adapter may communicate over the restricted agent IPC channel. If a separate human UI is added later, it requires a distinct authenticated protocol and a fresh threat-model review; it must not reuse the agent channel.

## Threat model and explicit limitations

This design prevents an agent from **requesting approval through the harness protocol**. It is not a security boundary against the logged-in machine owner, malware running as that user, an agent with unrestricted shell/process access, or a user who chooses to type an approval into the trusted console. OS same-user permissions alone do not distinguish a person from an agent process.

Therefore the OpenCode adapter must fail closed unless its effective tool catalog and permissions have been tested against all routes that can launch processes, send HTTP, invoke MCP/Code Mode, or access IPC. A policy file or prompt is not proof. The approval console must be visibly separate from model output and must never translate conversational approval into a gate decision.

No real project actions may be enabled until adversarial integration tests demonstrate that an agent cannot reach the host IPC endpoint, human console input, or any alternate action executor. If that proof is not achievable in OpenCode, the supported operating mode must require a stronger execution sandbox around the agent process, rather than treating same-user IPC ACLs as sufficient.

## Implementation sequence

1. Keep and test the existing pure controller/agent port split; ensure no agent facade can reach `controller.human`.
2. Define a minimal, versioned request/response schema for status and role-owned operations only.
3. Add a host process with persistent state, local IPC, project lock/recovery, and an interactive TTY approval console.
4. Add an OpenCode adapter that binds a session to a controller-issued role port and exposes only mapped operations.
5. Add adversarial tests for forged roles, replayed requests, direct socket/pipe access from agent tools, shell/HTTP/MCP/Code Mode, child agents, and restarts.
6. Harden and validate Windows named-pipe ACLs and macOS socket ownership, add client capability authentication and lifecycle/recovery, and keep real execution handlers disabled until every required bypass test passes on Windows and macOS.

## Rejected approach

Do not use OpenCode plugin RPC as the trusted human approval channel. V2 exposes plugin RPC as an ordinary server endpoint. A separate CLI/TUI dialog calling that endpoint does not, by itself, prove that the caller was a human; an agent with a route to the server endpoint could submit the same request.

## Prototype status

`src/host-ipc.ts` creates one endpoint per role and binds each endpoint to that role's controller port; role/action payloads are rejected by the existing controller schemas. It enforces an exclusive host lock and bounds newline-delimited JSON frames. `src/host-console.ts` permits plan approval only when standard input/output are interactive TTYs and confirms the exact displayed state target. `npm run host-demo` exercises the socket/pipe round trip with an isolated fixture. The demo's mock agent and host are in one process, and the Windows pipe ACL, real separate-process OpenCode client, raw IPC bypass resistance, and end-to-end install are not yet tested. A stale IPC lock requires manual cleanup/recovery and is not automatically stolen. It is a transport/flow prototype, not a security validation.
