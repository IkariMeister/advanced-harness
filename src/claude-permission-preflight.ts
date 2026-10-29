import type { NativeRole } from './native-role-types.ts';
import type { Capability, CapabilityRule } from './capability-policy.ts';
import type { RoleDefinition } from './role-definitions.ts';

export type ClaudePermissionFindingCode = 'precedence-conflict' | 'role-scope-unverified' | 'selector-mapping-unverified' | 'capability-mapping-unverified';
export type ClaudePermissionFindingStatus = 'incompatible-translation' | 'unverified-mapping';
export interface ClaudePermissionFinding {
  code: ClaudePermissionFindingCode;
  status: ClaudePermissionFindingStatus;
  role: NativeRole;
  ruleIndexes: number[];
  message: string;
  referenceUrls: string[];
}
export interface ClaudePermissionPreflightReport {
  host: 'claude-code';
  status: 'blocked' | 'no-blockers-detected';
  findings: ClaudePermissionFinding[];
  runtimeVerified: false;
}

const permissionsDocs = 'https://code.claude.com/docs/en/permissions';
const subagentsDocs = 'https://code.claude.com/docs/en/sub-agents';
const settingsDocs = 'https://code.claude.com/docs/en/settings';
const mcpDocs = 'https://code.claude.com/docs/en/mcp';
const rank = { allow: 1, ask: 2, deny: 3 } as const;

function overlaps(left: CapabilityRule, right: CapabilityRule): boolean | undefined {
  const capabilityOverlap = left.capability === right.capability || left.capability === 'all' || right.capability === 'all';
  if (!capabilityOverlap) return false;
  // A policy binding identifies the native action. Equal abstract capabilities do
  // not prove that distinct services/actions overlap on the target host.
  if (left.binding.action !== right.binding.action && left.capability !== 'all' && right.capability !== 'all') {
    if (left.resource.kind === 'all' && right.resource.kind === 'all') return undefined;
    return undefined;
  }
  if (left.resource.kind === 'all' || right.resource.kind === 'all') return true;
  if (left.resource.host === right.resource.host && left.resource.value === right.resource.value) return true;
  // Native pattern matching is intentionally not reimplemented here.
  return undefined;
}

function addGrouped(
  findings: ClaudePermissionFinding[],
  code: ClaudePermissionFindingCode,
  status: ClaudePermissionFindingStatus,
  role: NativeRole,
  indexes: readonly number[],
  message: string,
  referenceUrls: readonly string[]
): void {
  if (!indexes.length) return;
  findings.push({ code, status, role, ruleIndexes: [...new Set(indexes)].sort((a, b) => a - b), message, referenceUrls: [...referenceUrls] });
}

/** Diagnose known Claude Code policy translation blockers; this does not compile or validate runtime enforcement. */
export function preflightClaudePermissions(definitions: Record<NativeRole, RoleDefinition>): ClaudePermissionPreflightReport {
  const findings: ClaudePermissionFinding[] = [];
  for (const role of Object.keys(definitions) as NativeRole[]) {
    const rules = definitions[role].deployment.opencode.policy.rules;
    const precedenceIndexes = new Set<number>();
    for (let earlier = 0; earlier < rules.length; earlier++) {
      for (let later = earlier + 1; later < rules.length; later++) {
        const first = rules[earlier]!, second = rules[later]!;
        const overlap = overlaps(first, second);
        if (overlap === true && rank[first.effect] > rank[second.effect]) {
          precedenceIndexes.add(earlier); precedenceIndexes.add(later);
        }
      }
    }
    addGrouped(findings, 'precedence-conflict', 'incompatible-translation', role, [...precedenceIndexes],
      'OpenCode ordered-last-match exceptions cannot be represented faithfully by Claude Code deny > ask > allow priority when a later source rule has lower priority.', [permissionsDocs]);
    const uncertainBindings = new Set<number>();
    for (let earlier = 0; earlier < rules.length; earlier++) for (let later = earlier + 1; later < rules.length; later++) {
      if (overlaps(rules[earlier]!, rules[later]!) === undefined) { uncertainBindings.add(earlier); uncertainBindings.add(later); }
    }
    addGrouped(findings, 'capability-mapping-unverified', 'unverified-mapping', role, [...uncertainBindings],
      'Distinct native action bindings share an abstract capability, but their resource overlap is unknown; no conflict is inferred.', [permissionsDocs]);

    addGrouped(findings, 'role-scope-unverified', 'unverified-mapping', role, rules.map((_, index) => index),
      'Official Claude Code settings documentation does not establish an equivalent per-agent, resource-specific permission scope for this role policy.', [settingsDocs, subagentsDocs]);

    const selectorIndexes = rules.flatMap((rule, index) => rule.resource.kind === 'native-pattern' ? [index] : []);
    addGrouped(findings, 'selector-mapping-unverified', 'unverified-mapping', role, selectorIndexes,
      'OpenCode native resource patterns are opaque here; Claude Code selector matching and per-role application are not assumed equivalent.', [permissionsDocs, subagentsDocs]);

    const uncertain = new Map<Capability, number[]>();
    for (const [index, rule] of rules.entries()) {
      if (!['all', 'directory.external', 'user.question', 'agent.delegate', 'web.fetch', 'web.search', 'code-mode.execute', 'mcp.tool'].includes(rule.capability)) continue;
      const list = uncertain.get(rule.capability) ?? [];
      list.push(index); uncertain.set(rule.capability, list);
    }
    for (const [capability, indexes] of uncertain) {
      const refs = capability === 'mcp.tool' ? [mcpDocs, permissionsDocs] : capability === 'agent.delegate' ? [subagentsDocs, permissionsDocs] : [permissionsDocs];
      const detail = capability === 'code-mode.execute'
        ? 'OpenCode Code Mode execute is not treated as Claude Bash.'
        : capability === 'mcp.tool'
          ? 'OpenCode jira/github/figma/stitch action aliases do not establish a Claude MCP server/tool identity.'
          : capability === 'agent.delegate'
            ? 'Claude Agent(name) is a documented candidate only; full OpenCode subagent capability equivalence is unverified.'
            : `Capability ${capability} has no verified Claude permission binding in this preflight.`;
      addGrouped(findings, 'capability-mapping-unverified', 'unverified-mapping', role, indexes, detail, refs);
    }
  }
  return { host: 'claude-code', status: findings.length ? 'blocked' : 'no-blockers-detected', findings, runtimeVerified: false };
}

export function formatClaudePermissionPreflight(report: ClaudePermissionPreflightReport): string[] {
  return [
    `Claude Code source-policy preflight: ${report.status} (runtime verified: no).`,
    ...report.findings.flatMap(finding => [
      `  ${finding.code} [${finding.status}] role=${finding.role} rules=${finding.ruleIndexes.map(index => index + 1).join(',')} (zero-based indexes ${finding.ruleIndexes.join(',')}): ${finding.message}`,
      ...finding.referenceUrls.map(url => `    Reference: ${url}`)
    ])
  ];
}
