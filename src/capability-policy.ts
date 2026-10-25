import type { NativeRole } from './native-role-types.ts';
import type { PermissionRule } from './permission-reconciliation.ts';

export type Capability = 'all' | 'file.read' | 'file.find' | 'file.search' | 'file.edit' | 'directory.external' | 'shell.run' | 'user.question' | 'agent.delegate' | 'web.fetch' | 'web.search' | 'code-mode.execute' | 'mcp.tool';
export type CapabilityEffect = 'allow' | 'ask' | 'deny';
export type CapabilityResource = { kind: 'all' } | { kind: 'native-pattern'; host: 'opencode'; value: string };
export interface CapabilityRule { capability: Capability; resource: CapabilityResource; effect: CapabilityEffect; binding: { host: 'opencode'; action: string } }
export interface CapabilityPolicy { schemaVersion: 1; resolution: 'ordered-last-match'; rules: readonly CapabilityRule[] }
export type CapabilityDiagnosticCode = 'unknown-capability' | 'invalid-binding' | 'unresolved-selector' | 'unresolved-precedence';
export interface CapabilityDiagnostic { code: CapabilityDiagnosticCode; role?: NativeRole; ruleIndex?: number; host?: string; message: string }

const actionCapabilities: Record<string, Capability> = {
  '*': 'all',
  read: 'file.read', glob: 'file.find', grep: 'file.search', edit: 'file.edit',
  external_directory: 'directory.external', shell: 'shell.run', question: 'user.question',
  subagent: 'agent.delegate', webfetch: 'web.fetch', websearch: 'web.search', execute: 'code-mode.execute'
};
const mcpAction = /^(?:jira|github|figma|stitch)_\*$/;
const allowedEffects = ['allow', 'ask', 'deny'] as const;
function mappedCapability(action: string): Capability | undefined {
  return Object.hasOwn(actionCapabilities, action)
    ? actionCapabilities[action]
    : mcpAction.test(action) ? 'mcp.tool' : undefined;
}

export function normalizeOpenCodePolicy(role: NativeRole, permissions: readonly PermissionRule[]): { policy: CapabilityPolicy; diagnostics: CapabilityDiagnostic[] } {
  const rules: CapabilityRule[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];
  permissions.forEach((rule, index) => {
    const capability = mappedCapability(rule.action);
    if (!capability) {
      diagnostics.push({ code: 'unknown-capability', role, ruleIndex: index, host: 'opencode', message: `OpenCode action ${JSON.stringify(rule.action)} has no approved capability mapping.` });
      return;
    }
    if (!allowedEffects.includes(rule.effect)) {
      diagnostics.push({ code: 'invalid-binding', role, ruleIndex: index, host: 'opencode', message: `Unsupported permission effect at rule ${index}.` });
      return;
    }
    const resource: CapabilityResource = rule.resource === '*'
      ? { kind: 'all' }
      : { kind: 'native-pattern', host: 'opencode', value: rule.resource };
    rules.push({ capability, resource, effect: rule.effect, binding: { host: 'opencode', action: rule.action } });
  });
  return { policy: { schemaVersion: 1, resolution: 'ordered-last-match', rules }, diagnostics };
}

export function lowerOpenCodePolicy(role: NativeRole, policy: CapabilityPolicy): { permissions?: PermissionRule[]; diagnostics: CapabilityDiagnostic[] } {
  if (!policy || policy.schemaVersion !== 1 || policy.resolution !== 'ordered-last-match' || !Array.isArray(policy.rules)) {
    return { diagnostics: [{ code: 'unresolved-precedence', role, host: 'opencode', message: 'Capability policy version or ordered rules are unavailable; OpenCode precedence cannot be preserved.' }] };
  }
  const permissions: PermissionRule[] = [];
  const diagnostics: CapabilityDiagnostic[] = [];
  policy.rules.forEach((rule, index) => {
    if (!rule || !allowedEffects.includes(rule.effect)) {
      diagnostics.push({ code: 'invalid-binding', role, ruleIndex: index, host: 'opencode', message: `Invalid effect or binding in capability rule ${index}.` });
      return;
    }
    if (!rule.binding || rule.binding.host !== 'opencode' || typeof rule.binding.action !== 'string' || !rule.binding.action.trim()) {
      diagnostics.push({ code: 'invalid-binding', role, ruleIndex: index, ...(typeof rule.binding?.host === 'string' ? { host: rule.binding.host } : {}), message: `Capability rule ${index} has no valid OpenCode action binding.` });
      return;
    }
    const expected = mappedCapability(rule.binding.action);
    if (!expected) {
      diagnostics.push({ code: 'unknown-capability', role, ruleIndex: index, host: 'opencode', message: `OpenCode action ${JSON.stringify(rule.binding.action)} has no approved capability mapping.` });
      return;
    }
    if (expected !== rule.capability) {
      diagnostics.push({ code: 'invalid-binding', role, ruleIndex: index, host: 'opencode', message: `Action binding ${JSON.stringify(rule.binding.action)} does not match capability ${JSON.stringify(rule.capability)}.` });
      return;
    }
    if (!rule.resource || rule.resource.kind === 'all') {
      if (rule.resource?.kind !== 'all') {
        diagnostics.push({ code: 'unresolved-selector', role, ruleIndex: index, host: 'opencode', message: `Capability rule ${index} has an unsupported resource selector.` });
        return;
      }
      permissions.push({ action: rule.binding.action, resource: '*', effect: rule.effect });
    } else if (rule.resource.kind === 'native-pattern' && rule.resource.host === 'opencode' && typeof rule.resource.value === 'string' && rule.resource.value.length > 0) {
      permissions.push({ action: rule.binding.action, resource: rule.resource.value, effect: rule.effect });
    } else {
      diagnostics.push({ code: 'unresolved-selector', role, ruleIndex: index, host: 'opencode', message: `Capability rule ${index} has an unsupported native resource selector.` });
    }
  });
  if (diagnostics.length) return { diagnostics };
  return { permissions, diagnostics };
}
