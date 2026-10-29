import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { nativeRoles, modelReference, type NativeRole } from './native-role-types.ts';
import { lowerOpenCodePolicy, normalizeOpenCodePolicy, type Capability, type CapabilityDiagnostic, type CapabilityPolicy, type CapabilityResource, type CapabilityRule } from './capability-policy.ts';

export interface RoleDefinition {
  schemaVersion: 1;
  id: NativeRole;
  description: string;
  orchestration: 'primary' | 'subagent';
  instructions: string;
  deployment: { opencode: { model: string; policy: CapabilityPolicy } };
  diagnostics: readonly CapabilityDiagnostic[];
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function parseV2Policy(value: unknown, role: NativeRole, source: string): CapabilityPolicy {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'resolution', 'rules']) || value.schemaVersion !== 1 || value.resolution !== 'ordered-last-match' || !Array.isArray(value.rules)) {
    throw new Error(`Invalid or unsupported capability policy schema/resolution: ${source}`);
  }
  const rules = value.rules.map((entry, index): CapabilityRule => {
    if (!record(entry) || !exactKeys(entry, ['capability', 'resource', 'effect', 'binding'])) throw new Error(`Invalid capability rule fields at ${index} in ${source}`);
    if (typeof entry.capability !== 'string' || typeof entry.effect !== 'string' || !['allow', 'ask', 'deny'].includes(entry.effect)) throw new Error(`Invalid capability/effect at rule ${index} in ${source}`);
    if (!record(entry.binding) || !exactKeys(entry.binding, ['host', 'action']) || entry.binding.host !== 'opencode' || typeof entry.binding.action !== 'string' || !entry.binding.action.trim()) throw new Error(`Invalid OpenCode binding at rule ${index} in ${source}`);
    let resource: CapabilityResource;
    if (record(entry.resource) && exactKeys(entry.resource, ['kind']) && entry.resource.kind === 'all') resource = { kind: 'all' };
    else if (record(entry.resource) && exactKeys(entry.resource, ['kind', 'host', 'value']) && entry.resource.kind === 'native-pattern' && entry.resource.host === 'opencode' && typeof entry.resource.value === 'string' && entry.resource.value.length > 0) resource = { kind: 'native-pattern', host: 'opencode', value: entry.resource.value };
    else throw new Error(`Unsupported capability resource selector at rule ${index} in ${source}`);
    return { capability: entry.capability as Capability, resource, effect: entry.effect as CapabilityRule['effect'], binding: { host: 'opencode', action: entry.binding.action } };
  });
  const policy: CapabilityPolicy = { schemaVersion: 1, resolution: 'ordered-last-match', rules };
  const validation = lowerOpenCodePolicy(role, policy);
  if (validation.diagnostics.length) throw new Error(`Invalid capability policy in ${source}: ${validation.diagnostics.map(item => `${item.code}: ${item.message}`).join('; ')}`);
  return policy;
}

export function loadRoleDefinition(text: string, id: NativeRole, source = `${id}.md`): RoleDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Malformed role definition frontmatter: ${source}`);
  const document = parseDocument(match[1]!);
  const header: unknown = document.toJSON();
  if (document.errors.length || !record(header)) throw new Error(`Malformed role definition frontmatter: ${source}`);
  const versioned = Object.hasOwn(header, 'schemaVersion');
  if (versioned && header.schemaVersion !== 2) throw new Error(`Unsupported role source schema version: ${source}`);
  const allowed = versioned ? ['schemaVersion', 'description', 'mode', 'model', 'policy'] : ['description', 'mode', 'model', 'permissions'];
  if (Object.keys(header).some(key => !allowed.includes(key))) throw new Error(`Unknown role definition field: ${source}`);
  if (!exactKeys(header, allowed)) throw new Error(`Incomplete role definition frontmatter: ${source}`);
  if (typeof header.description !== 'string' || !header.description.trim()) throw new Error(`Invalid role description: ${source}`);
  const expectedMode = id === 'lead' ? 'primary' : 'subagent';
  if (header.mode !== expectedMode) throw new Error(`Invalid role mode for ${id}: ${source}`);
  const model = modelReference(header.model);
  if (!model) throw new Error(`Invalid role model: ${source}`);
  let policy: CapabilityPolicy;
  let diagnostics: CapabilityDiagnostic[];
  if (versioned) {
    policy = parseV2Policy(header.policy, id, source);
    diagnostics = [];
  } else {
    if (!Array.isArray(header.permissions)) throw new Error(`Invalid role permissions: ${source}`);
    const permissions = header.permissions.map((entry, index) => {
      if (!record(entry) || !exactKeys(entry, ['action', 'resource', 'effect'])) throw new Error(`Invalid permission rule ${index + 1}: ${source}`);
      if (typeof entry.action !== 'string' || !entry.action.trim() || typeof entry.resource !== 'string' || !entry.resource.trim() || typeof entry.effect !== 'string' || !['allow', 'ask', 'deny'].includes(entry.effect)) throw new Error(`Invalid permission rule ${index + 1}: ${source}`);
      return { action: entry.action, resource: entry.resource, effect: entry.effect as 'allow' | 'ask' | 'deny' };
    });
    const normalized = normalizeOpenCodePolicy(id, permissions);
    policy = normalized.policy;
    diagnostics = normalized.diagnostics;
  }
  const instructions = match[2]!.trim();
  if (!instructions) throw new Error(`Role instructions must not be empty: ${source}`);
  return { schemaVersion: 1, id, description: header.description, orchestration: expectedMode, instructions, deployment: { opencode: { model, policy } }, diagnostics };
}

export function loadRoleDefinitions(directory: string): Record<NativeRole, RoleDefinition> {
  const names = readdirSync(directory).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
  const expected = nativeRoles.map(role => `${role}.md`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Role source directory must contain exactly the eight canonical role files.');
  return Object.fromEntries(nativeRoles.map(role => [role, loadRoleDefinition(readFileSync(join(directory, `${role}.md`), 'utf8'), role)])) as Record<NativeRole, RoleDefinition>;
}
