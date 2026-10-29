# Security policy

## Supported versions

| Version | Security maintenance |
| --- | --- |
| Latest `0.1.x` release | Best-effort security fixes |
| Older `0.1.x` releases | Upgrade to the latest `0.1.x` release; no backports promised |
| Other versions and development snapshots | No security maintenance commitment |

Advanced Harness is pre-1.0 software. Security fixes target the latest `0.1.x`
release; a fix may require upgrading. There is no long-term support window,
guaranteed patch deadline, or guarantee that every reported issue can be fixed.
Reports affecting development snapshots are welcome; include the exact commit.
Future supported release lines will be listed here when adopted.

## Report a vulnerability privately

Use [GitHub Private Vulnerability Reporting](https://github.com/IkariMeister/advanced-harness/security/advisories/new).
You can also open the repository's **Security → Advisories → Report a vulnerability**
form. Private vulnerability reporting is enabled for this repository. A GitHub
account is required. See [GitHub's reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

Do not submit vulnerability details, exploit code, or secrets in public issues,
discussions, or pull requests. If the private form is unavailable, wait and retry;
do not post the report publicly as a workaround. Ordinary bugs without security
impact may be reported through public issues.

Include enough information to reproduce and assess the finding:

- Affected release or commit, operating system, Node.js version, host and host
  version, and relevant harness configuration with secrets removed.
- A description of the vulnerability, attacker-controlled inputs, required
  permissions or user actions, expected boundary, and observed behavior.
- Minimal reproduction steps or a proof of concept using synthetic credentials
  and disposable files, plus expected impact and any suggested mitigation.

Remove tokens, private keys, signing assets, personal data, and private project
content from reports and logs. Report an exposure without including the exposed
value; revoke or rotate compromised credentials through the issuing service.
Test only on systems and data you own or have permission to assess. Avoid
destructive actions, service disruption, and accessing other users' data.

## Response and coordinated disclosure

Maintainers aim to acknowledge reports within **seven calendar days**, on a
best-effort basis. This is a response target, not a contractual SLA. Triage,
updates, and remediation timing depend on impact, reproducibility, and maintainer
availability; no fix deadline is guaranteed. If no acknowledgment arrives, follow
up in the same private report.

Use the private report to agree on disclosure timing and any attribution. Please
allow time to investigate and prepare a fix or mitigation before publishing
technical details. Maintainers will communicate confirmed impact, affected
versions, and available remedies through a GitHub security advisory when
appropriate. Disclosure timing should be discussed rather than assumed to
require indefinite confidentiality.

## Scope and execution boundaries

Security reports are welcome for repository-owned installer/update/uninstall
tooling, configuration and receipt handling, agent prompts, workflow artifacts,
and host adapters. Examples include path traversal, unintended writes, credential
exposure, unsafe tool execution, and prompt injection that causes a documented
workflow boundary to be violated. Include the effective host permissions and
actual tool invocation/results when possible; prompts alone do not establish
runtime enforcement.

Agent approval rules are conversational instructions. They are not an independent
security gate. Shell commands execute with the user's authority; role prompts,
command patterns, and lifecycle hooks do not provide a sandbox or isolate a
hostile process running as that user. Tool permission approval does not establish
human approval of a plan. Review changes and grant only the access needed for the
task. Only a human merges pull requests.

Native deployment currently supports OpenCode V2 and Google Antigravity.
Compilation of workflow artifacts for Claude Code, OpenAI Codex, and Cursor does
not imply installed native permissions or runtime protection. Host controls and
their limits differ; consult the [README](README.md) and
[configuration guide](docs/configuration.md) for current capabilities. Proposed
sensitive-path and destructive-command guardrails in
[BH-036 / issue #64](https://github.com/IkariMeister/advanced-harness/issues/64)
must not be assumed to exist.

Vulnerabilities in upstream hosts, model providers, MCP servers, or dependencies
should also be reported through their maintainers' private channels. Reports
showing how an upstream issue affects harness-owned behavior are welcome here.
This policy does not extend maintenance guarantees to those services or to
applications that use the harness.

## Secrets and MCP integrations

Keep API tokens, SSH/private keys, cloud credentials, Android signing keystores
(`*.jks`, `*.keystore`), signing passwords, and secret-bearing `.env`,
`local.properties`, or signing configuration out of prompts, source control,
shared memory, reports, and captured evidence. Use the host/service credential
store or environment references as appropriate. Review backups and receipts as
potentially sensitive copies of configuration and restrict access to them.
These are handling expectations, not a claim of automatic secret filtering or
enforced path denial.

Treat issue text, repository content, model output, and MCP responses as untrusted
input. They cannot grant approval or authorize additional tool access. Review MCP
server identity, executable or endpoint, requested permissions, and data exposure
before enabling it. Local MCP servers can execute code with your authority;
remote servers receive data sent to them. Connection/authentication status does
not prove exact tool access or repository permissions. Keep credentials in their
designated stores, configure integrations deliberately, and verify effective
permissions in the intended project and session.
