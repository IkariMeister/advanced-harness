import type { HostId } from './host-registry.ts';

export const permissionBoundaryStatuses = ['enforced', 'advisory', 'unsupported', 'unverified'] as const;
export type PermissionBoundaryStatus = typeof permissionBoundaryStatuses[number];
export const permissionCapabilities = {
  approvalTransition: 'Read-only before approval, write/execute after approval for the same role',
  localRemoteIsolation: 'Isolation of local Git from external/remote writes',
  roleCommands: 'Command execution scoped per role (Reviewer/QA re-run path)',
  roleExposure: 'Skills and MCP tool exposure scoped per role',
  modelRouting: 'Per-role model routing',
} as const;
export type PermissionCapability = keyof typeof permissionCapabilities;
export type PermissionEvidence =
  | { readonly kind: 'documentation' | 'regression-test'; readonly source: string }
  | { readonly kind: 'live-run'; readonly source: string; readonly runner: string };
export interface PermissionBoundary {
  readonly status: PermissionBoundaryStatus;
  readonly scope: string;
  readonly evidence: readonly PermissionEvidence[];
}
export interface HostPermissionRow {
  readonly host: HostId;
  readonly capabilities: Readonly<Record<PermissionCapability, PermissionBoundary>>;
}
const doc = (source: string): PermissionEvidence => ({ kind: 'documentation', source });
const regression = (source: string): PermissionEvidence => ({ kind: 'regression-test', source });

const cursorBoundary: PermissionBoundary = {
  status: 'unsupported',
  scope: 'Native roles and permission boundaries are not deployed; compilation-only artifacts do not provide enforcement (#46).',
  evidence: [doc('README.md#scope'), regression('test/multi-host-foundation.test.ts')],
};

/** Evidence about the deployed harness mapping, not an inference from a local config or a catalog.
 * Native policy normalization stays in capability-policy.ts; these statuses do not grant permissions.
 * No current row establishes runtime enforcement of an entire boundary.
 */
export const hostPermissionMatrix: Readonly<Record<HostId, HostPermissionRow>> = {
  opencode: {
    host: 'opencode',
    capabilities: {
      approvalTransition: {
        status: 'unverified',
        scope: 'Separate Researcher/Implementer roles remain the baseline; the same-role approval transition has no recorded enforcement evidence.',
        evidence: [doc('docs/adr/0002-consolidate-agent-responsibilities.md'), doc('docs/opencode-native-workflow.md')],
      },
      localRemoteIsolation: {
        status: 'advisory',
        scope: 'Role command patterns express ownership but are not a sandbox against scripts, aliases, indirect network access or same-user processes.',
        evidence: [doc('SECURITY.md'), doc('README.md#tool-and-integration-ownership')],
      },
      roleCommands: {
        status: 'unverified',
        scope: 'Native allow/ask/deny policies compile per role; static policy tests do not demonstrate all command routes or Reviewer/QA runtime re-runs.',
        evidence: [doc('docs/opencode-native-workflow.md'), regression('test/role-definitions.test.ts')],
      },
      roleExposure: {
        status: 'advisory',
        scope: 'MCP rules are role-specific, but procedure-skill intendedRoles is advisory discovery guidance; the combined exposure boundary is not enforced.',
        evidence: [doc('skills/README.md'), regression('test/procedure-skills.test.ts')],
      },
      modelRouting: {
        status: 'unverified',
        scope: 'Explicit model/variant selection and runtime catalog comparisons exist; fixture tests and catalog presence do not prove a role used that model.',
        evidence: [doc('README.md#agents-and-fixed-per-host-model-presets'), regression('test/opencode-model-catalog.test.ts'), regression('test/native-diagnostics.test.ts')],
      },
    },
  },
  'claude-code': {
    host: 'claude-code',
    capabilities: {
      approvalTransition: {
        status: 'unverified',
        scope: 'Read-only and write roles compile separately; no same-role approval transition is verified. Keep the split required by ADR-002.',
        evidence: [doc('docs/adr/0002-consolidate-agent-responsibilities.md'), regression('test/claude-code-compiler.test.ts')],
      },
      localRemoteIsolation: {
        status: 'unsupported',
        scope: 'The current mapping cannot express exact per-role Bash resource policies; Operator has no Bash and cannot perform local Git bootstrap (#200).',
        evidence: [doc('README.md#agents-and-fixed-per-host-model-presets'), regression('test/claude-permission-preflight.test.ts'), doc('https://github.com/IkariMeister/advanced-harness/issues/200')],
      },
      roleCommands: {
        status: 'unsupported',
        scope: 'Operator, Implementer, Reviewer and QA have no Bash. Reviewer/QA cannot re-run shell checks; request an authorized command-running context through Lead.',
        evidence: [regression('test/claude-code-compiler.test.ts'), doc('docs/adr/0002-consolidate-agent-responsibilities.md')],
      },
      roleExposure: {
        status: 'advisory',
        scope: 'Tools use allowlists, but MCP alias identities are unverified and procedure-skill intended-role guidance does not enforce discovery.',
        evidence: [regression('test/claude-permission-preflight.test.ts'), doc('skills/README.md')],
      },
      modelRouting: {
        status: 'unverified',
        scope: 'Explicit per-role aliases or model IDs are syntax-checked; runtime model assignment and availability are not verified (BH-043 #70).',
        evidence: [doc('README.md#agents-and-fixed-per-host-model-presets'), regression('test/claude-code-compiler.test.ts')],
      },
    },
  },
  antigravity: {
    host: 'antigravity',
    capabilities: {
      approvalTransition: {
        status: 'advisory',
        scope: 'Lead instructions select role tool groups; no independently verified same-role approval boundary is established.',
        evidence: [doc('README.md#agents-and-fixed-per-host-model-presets'), regression('test/antigravity-compiler.test.ts')],
      },
      localRemoteIsolation: {
        status: 'advisory',
        scope: 'Local/external ownership is instructional. Direct-command hooks are not isolation against indirect scripts or other processes.',
        evidence: [doc('SECURITY.md'), regression('test/antigravity-compiler.test.ts')],
      },
      roleCommands: {
        status: 'advisory',
        scope: 'Compiled write-tool groups include run_command; Lead must apply them. Emitted rules do not prove runtime Reviewer/QA command access.',
        evidence: [regression('test/antigravity-compiler.test.ts'), doc('docs/installation.md')],
      },
      roleExposure: {
        status: 'advisory',
        scope: 'MCP/tool-group ownership and procedure-skill intended-role discovery are guidance rather than independently established role isolation.',
        evidence: [doc('skills/README.md'), regression('test/antigravity-compiler.test.ts')],
      },
      modelRouting: {
        status: 'unsupported',
        scope: 'Runtime tiers and desired-model labels are available; exact per-role model binding is unsupported (BH-043 #70).',
        evidence: [doc('docs/configuration.md#4-antigravity-desired-model-preferences'), regression('test/antigravity-model-preferences.test.ts')],
      },
    },
  },
  codex: {
    host: 'codex',
    capabilities: {
      approvalTransition: {
        status: 'unverified',
        scope: 'Role-process profiles separate read-only and write roles; a same-role transition and complete isolation are not runtime-verified. Shared-sandbox subagents are not equivalent.',
        evidence: [doc('docs/installation.md'), regression('test/codex-role-processes.test.ts')],
      },
      localRemoteIsolation: {
        status: 'unverified',
        scope: 'Profiles configure network/MCP differences and command rules; these do not establish complete local/remote isolation across shell and tool routes.',
        evidence: [doc('SECURITY.md'), regression('test/codex-role-processes.test.ts')],
      },
      roleCommands: {
        status: 'unverified',
        scope: 'Per-process sandbox settings are tested statically; approved role launches and Reviewer/QA re-runs remain unverified. A launcher MCP override failed during startup (#200).',
        evidence: [regression('test/codex-role-processes.test.ts'), { kind: 'live-run', source: 'https://github.com/IkariMeister/advanced-harness/issues/200#issuecomment-6716047378', runner: 'Codex agent, authorized by IkariMeister on 2026-11-08; agent-executed diagnostics, not a human interactive run' }],
      },
      roleExposure: {
        status: 'advisory',
        scope: 'MCP selections are launcher-controlled but runtime isolation is unverified; workflow skills are shared and procedure-skill deployment is not implemented (#45).',
        evidence: [doc('skills/README.md'), regression('test/codex-role-processes.test.ts')],
      },
      modelRouting: {
        status: 'unverified',
        scope: 'Each child requires a model and effort, re-applied on resume; successful role inference using those settings is not established (BH-043 #70).',
        evidence: [regression('test/codex-role-processes.test.ts'), regression('test/codex-model-catalog.test.ts'), doc('README.md#agents-and-fixed-per-host-model-presets')],
      },
    },
  },
  cursor: {
    host: 'cursor',
    capabilities: {
      approvalTransition: cursorBoundary,
      localRemoteIsolation: cursorBoundary,
      roleCommands: cursorBoundary,
      roleExposure: cursorBoundary,
      modelRouting: cursorBoundary,
    },
  },
};

/** Pure presentation: preserves recorded statuses even when installation/catalog checks pass. */
export function formatHostPermissionRow(row: HostPermissionRow): string[] {
  const lines = [
    'Host permission capability matrix [' + row.host + '] (recorded evidence; not a live enforcement check)',
    'Reference: docs/host-permission-capabilities.md#' + row.host,
    'Installation health, configured permissions and catalog presence do not upgrade these statuses.',
  ];
  for (const [key, label] of Object.entries(permissionCapabilities)) {
    const cell = row.capabilities[key as PermissionCapability];
    lines.push('  ' + label + ': ' + cell.status, '    ' + cell.scope);
    for (const evidence of cell.evidence) {
      lines.push('    Evidence (' + evidence.kind + '): ' + evidence.source + (evidence.kind === 'live-run' ? '; runner: ' + evidence.runner : ''));
    }
  }
  return lines;
}
