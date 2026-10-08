# Markdown restriction-test agents

These are experimental role templates, not an installable production harness.
Models and reasoning variants match the root README. Every role denies by
default; Lead can launch only the seven named roles. No agent has native shell,
write/edit, web, MCP, or Code Mode permission. Host action permissions do not
replace the controller's per-action ownership checks.

Run `npm run agent-test:prepare` from the harness checkout using Node 24.
It creates a new disposable directory under `%LOCALAPPDATA%/Temp/opencode`
on Windows or the temporary directory on macOS, without touching global config
or credentials. Researcher's read exception is bound to that fixture's absolute
path; do not install the templates directly.

Open the printed directory in OpenCode, start a **new** session, select `lead`,
and explicitly select GPT-6 Astra with medium reasoning. Primary-agent selection
does not reset a session's model. Paste the generated `TEST-PROMPT.txt`.
The other roles use their fixed models; stop on access errors, without fallback.

The stage-one project deliberately loads **no host plugin**. It tests native
OpenCode permissions and delegation, independently of plugin tool filtering.
It does not test host approval, cross-role host actions, or IPC isolation.

Before relying on the setup, inspect effective config and registered agents.
From the generated project, run `opencode debug agents` and confirm all eight
roles, models/variants, and permission lists. Also run `opencode debug config`.
The tested CLI 2.0.24 discovers `.opencode/agent/`, while the current V2 docs
specify `.opencode/agents/`; the preparation script writes identical definitions
to both layouts. This discrepancy was reproduced in a disposable WSL project:
plural alone listed no agents; singular parsed all eight correctly when a
temporary model-less diagnostic agent was also present. The isolated profile
has no usable OpenAI credentials; with only fixed-model agents, its listing
was empty even with the singular directory. No diagnostic/fallback agent is
installed in the generated Windows project. Discovery and account/model access
must be checked with your authenticated Windows profile before running probes.
Global/ancestor config, plugins, MCP servers, and session permission rules may
still be present; a disposable folder is not OS isolation. Do not test external
service access or broad bypass commands. A model refusal alone is untested.
An absent tool is not exposed; a permission error is denied; successful forbidden
execution fails the test. Confirm `fixture/blocked.txt` was not created and
`fixture/greeting.txt` remains unchanged from a trusted terminal afterward.

Stage two needs the host runner and adapter, with host audit evidence. Do not
claim stage-one success establishes approval or production security.

## Stage-two host-adapter test

Configure an already marked disposable project with:

```text
npm run host-test:configure -- <absolute-disposable-project-path>
```

This deploys a local package under `.opencode/plugins/advanced-harness`, installs
its pinned plugin dependency with lifecycle scripts disabled, binds its IPC
client to the project-specific host directory, and writes `TEST-HOST-PROMPT.txt`.
It does not change global OpenCode configuration. In a separate interactive terminal,
start the trusted host from this harness checkout:

```text
npm run host-test:run -- <absolute-disposable-project-path>
```

Keep that terminal visible. Open a new Desktop session in the disposable
project, select Lead and its required model/variant, and paste the host prompt.
The host terminal will display the exact plan and target. Cancellation changes
nothing; approval requires typing the complete displayed `approve <target>`
token in that terminal. Chat text cannot approve it.

The fixture host refuses unmarked projects and registers only one mutation:
`fixture/greeting.txt` can become exactly `APPROVED_BY_HOST` plus one newline.
Its SQLite state and IPC endpoints live under the current user's
`~/.advanced-harness/smoke-tests/`, outside the disposable fixture. Stop it with
Ctrl+C. Restart currently invokes the controller's fail-closed recovery pause;
this smoke runner does not yet expose a resume/reconciliation console.

## Desktop stage-one result (2026-10-08)

OpenCode Desktop discovered Lead and all seven named children in the disposable
Windows project. Lead delegated successfully to Researcher, Planner,
Implementer, Operator, External, Reviewer, and QA; `general` was absent from
Lead's available-agent list. Researcher reported the exact fixture greeting.
The remaining children reported no native or `harness_*` tools. A trusted
post-run filesystem check confirmed `fixture/greeting.txt` was unchanged and
`fixture/blocked.txt` did not exist.

This is a limited catalog/delegation smoke-test pass. Desktop did not expose the
children's underlying tool traces to Lead, so the fixture read and child catalog
details remain child-reported. Shell, edit, and nested-subagent calls were not
available and therefore no runtime permission-denial result was demonstrated.
Session metadata exposed GPT-6 Astra but not authoritative Lead identity or the
reasoning variant. Operator and External initially failed because the required
GPT-5.3 Codex Spark model was unsupported by the active ChatGPT account; the
disposable project alone was explicitly changed to GPT-6 Luna low for the retry.
The source templates and production model requirements were not changed.

This result does not exercise the host adapter, controller, approval console,
cross-role host checks, external services, OS isolation, or same-user-process
resistance. It is not evidence that the harness is production-safe.
