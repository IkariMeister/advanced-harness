import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import test from 'node:test';
import { loadNativeDefinitions, nativeRoles, type NativeDefinition } from '../src/native-installer.ts';
import { loadRoleDefinition, loadRoleDefinitions } from '../src/role-definitions.ts';
import { compileOpenCodeRole, compileOpenCodeRoles } from '../src/opencode-role-compiler.ts';
import { lowerOpenCodePolicy, type CapabilityPolicy } from '../src/capability-policy.ts';

const agents = new URL('../agents/', import.meta.url);
const source = (role: typeof nativeRoles[number]) => readFileSync(new URL(`${role}.md`, agents), 'utf8');
const legacyAgents = new URL('./fixtures/legacy-role-sources/', import.meta.url);
const legacySource = (role: typeof nativeRoles[number]) => readFileSync(new URL(`${role}.md`, legacyAgents), 'utf8');
function editFrontmatter(text: string, edit: (header: Record<string, unknown>) => void): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)!;
  const header = parseDocument(match[1]!).toJSON() as Record<string, unknown>;
  edit(header);
  return `---\n${stringify(header, { lineWidth: 0 })}---\n${match[2]}`;
}

const capturedArtifact = JSON.parse(readFileSync(new URL('./fixtures/compiled-role-definitions.json', import.meta.url), 'utf8')) as {
  provenance: string;
  definitions: Record<typeof nativeRoles[number], NativeDefinition>;
};
const legacyNormalizedDefinitions = () => capturedArtifact.definitions;

test('strict role source compiler preserves current normalized OpenCode definitions for all roles', () => {
  const baseline = legacyNormalizedDefinitions();
  assert.match(capturedArtifact.provenance, /reconstructed after v2 source migration/i);
  const agentsDirectory = fileURLToPath(agents);
  const compiled = compileOpenCodeRoles(loadRoleDefinitions(agentsDirectory));
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.definitions, baseline);
  assert.deepEqual(loadNativeDefinitions(agentsDirectory), baseline);
  assert.deepEqual(loadNativeDefinitions(fileURLToPath(legacyAgents)), baseline);
  for (const role of nativeRoles) {
    const current = source(role), prior = legacySource(role);
    const currentBody = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(current)?.[1]?.trim();
    const legacyBody = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(prior)?.[1]?.trim();
    assert.equal(currentBody, legacyBody, `${role} source instructions preserved`);
  }
  for (const role of nativeRoles) {
    const actual: NativeDefinition = compiled.definitions![role];
    assert.equal(actual.description, baseline[role].description);
    assert.equal(actual.mode, role === 'lead' ? 'primary' : 'subagent');
    assert.equal(actual.model, baseline[role].model);
    assert.deepEqual(actual.permissions, baseline[role].permissions);
    assert.equal(actual.system, baseline[role].system);
    assert.notEqual(actual.permissions, baseline[role].permissions);
  }
});

test('loader validates role-specific mode, model syntax, description, and instructions', () => {
  for (const role of nativeRoles) {
    const text = legacySource(role);
    const expectedMode = role === 'lead' ? 'primary' : 'subagent';
    assert.equal(loadRoleDefinition(text, role).orchestration, expectedMode);
    assert.throws(() => loadRoleDefinition(text.replace(`mode: ${expectedMode}`, `mode: ${expectedMode === 'primary' ? 'subagent' : 'primary'}`), role), /mode/i);
    assert.throws(() => loadRoleDefinition(text.replace(/model: .+/, 'model: invalid-model'), role), /model/i);
    assert.throws(() => loadRoleDefinition(text.replace(/description: .+/, 'description: ""'), role), /description/i);
    assert.throws(() => loadRoleDefinition(text.replace(/---\r?\n([\s\S]*?)\r?\n---\r?\n[\s\S]*/, '---\n$1\n---\n   \n'), role), /instructions/i);
  }
});

test('loader rejects unknown and duplicate YAML fields and malformed permission records without mutations', t => {
  const dir = mkdtempSync(join(tmpdir(), 'role-definition-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const role of nativeRoles) writeFileSync(join(dir, `${role}.md`), legacySource(role));
  const leadPath = join(dir, 'lead.md');
  const valid = readFileSync(leadPath, 'utf8');
  const invalid = [
    valid.replace('description:', 'unknown: value\ndescription:'),
    valid.replace('description:', 'description: duplicate\ndescription:'),
    valid.replace('effect: deny', 'effect: maybe'),
    valid.replace('action: "*"', 'action: ""'),
    valid.replace('resource: "*"', 'resource: ""'),
    valid.replace('effect: deny', 'effect: deny, extra: yes'),
    valid.replace('effect: deny', 'effect: [deny]'),
    valid.replace('effect: deny', 'effect: 1'),
    valid.replace('effect: deny', 'effect: true'),
    valid.replace('permissions:', 'permissions: invalid')
  ];
  for (const candidate of invalid) {
    writeFileSync(leadPath, candidate);
    assert.throws(() => loadRoleDefinitions(dir));
    assert.equal(readFileSync(leadPath, 'utf8'), candidate);
  }
  assert.deepEqual(readdirSync(dir).sort(), [...nativeRoles.map(role => `${role}.md`)].sort());
});

test('OpenCode role compiler returns independent ordered permission data', () => {
  const definitions = loadRoleDefinitions(fileURLToPath(agents));
  const sourceDefinition = definitions.external;
  const compiled = compileOpenCodeRole(sourceDefinition);
  const lowered = lowerOpenCodePolicy('external', sourceDefinition.deployment.opencode.policy);
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.definition?.permissions, lowered.permissions);
  assert.deepEqual(compiled.definition?.permissions[0], lowered.permissions?.[0]);
  assert.notEqual(compiled.definition?.permissions, lowered.permissions);
  assert.notEqual(compiled.definition?.permissions[0], lowered.permissions?.[0]);
});

test('capability normalization round-trips ordered OpenCode rules without changing policy semantics', () => {
  const definitions = loadRoleDefinitions(fileURLToPath(agents));
  for (const role of nativeRoles) {
    const policy = definitions[role].deployment.opencode.policy;
    const lowered = lowerOpenCodePolicy(role, policy);
    assert.deepEqual(lowered.diagnostics, [], role);
    assert.deepEqual(lowered.permissions, legacyNormalizedDefinitions()[role].permissions, role);
    assert.deepEqual(policy.rules.map(rule => rule.binding.action), legacyNormalizedDefinitions()[role].permissions.map(rule => (rule as { action: string }).action));
  }
  const leadRules = definitions.lead.deployment.opencode.policy.rules;
  assert.deepEqual(leadRules[0], { capability: 'all', resource: { kind: 'all' }, effect: 'deny', binding: { host: 'opencode', action: '*' } });
  assert.ok(leadRules.some(rule => rule.binding.action === 'read' && rule.resource.kind === 'native-pattern' && rule.resource.value === '*.env' && rule.effect === 'ask'));
  const externalRules = definitions.external.deployment.opencode.policy.rules;
  assert.ok(externalRules.some(rule => rule.capability === 'shell.run' && rule.binding.action === 'shell' && rule.effect === 'ask'));
  assert.ok(externalRules.some(rule => rule.binding.action === 'shell' && rule.resource.kind === 'native-pattern' && rule.resource.value === 'gh.exe pr merge' && rule.effect === 'deny'));
  assert.ok(externalRules.some(rule => rule.capability === 'code-mode.execute' && rule.binding.action === 'execute'));
  for (const action of ['jira_*', 'github_*', 'figma_*', 'stitch_*']) assert.ok(externalRules.some(rule => rule.capability === 'mcp.tool' && rule.binding.action === action));
});

test('v2 role sources reject unsupported versions, duplicate authorities, malformed nested policy, and mismatches', () => {
  const valid = source('lead');
  const badSources = [
    editFrontmatter(valid, header => { header.schemaVersion = 3; }),
    editFrontmatter(valid, header => { header.permissions = []; }),
    editFrontmatter(valid, header => { header.unknown = true; }),
    editFrontmatter(valid, header => { (header.policy as Record<string, unknown>).schemaVersion = 2; }),
    editFrontmatter(valid, header => { (header.policy as Record<string, unknown>).resolution = 'unordered'; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: Record<string, unknown>[] }).rules; rules[0]!.extra = true; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: Record<string, unknown>[] }).rules; rules[0]!.effect = ['deny']; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: { binding: Record<string, unknown> }[] }).rules; rules[0]!.binding.host = 'codex'; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: Record<string, unknown>[] }).rules; (rules[0]!.binding as Record<string, unknown>).action = 'shell'; }),
    editFrontmatter(valid, header => { const rules = (header.policy as { rules: { resource: Record<string, unknown> }[] }).rules; rules[0]!.resource.kind = 'unsupported'; }),
    editFrontmatter(valid, header => { (header.policy as Record<string, unknown>).resolution = 'first-match'; })
  ];
  for (const candidate of badSources) assert.throws(() => loadRoleDefinition(candidate, 'lead'));
  assert.throws(() => loadRoleDefinition(valid.replace('schemaVersion: 2', 'schemaVersion: 1'), 'lead'), /version/i);
});

test('unsupported capability actions and invalid internal bindings/selectors produce structured diagnostics', () => {
  const raw = legacySource('lead').replace('action: read,', 'action: future_action,');
  const role = loadRoleDefinition(raw, 'lead');
  assert.equal(role.diagnostics[0]?.code, 'unknown-capability');
  assert.equal(role.diagnostics[0]?.role, 'lead');
  const result = compileOpenCodeRole(role);
  assert.equal(result.definition, undefined);
  assert.equal(result.diagnostics[0]?.code, 'unknown-capability');
  for (const inherited of ['constructor', 'toString', '__proto__']) {
    const inheritedAction = loadRoleDefinition(legacySource('lead').replace('action: read,', `action: ${inherited},`), 'lead');
    assert.ok(inheritedAction.diagnostics.some(item => item.code === 'unknown-capability' && item.message.includes(inherited)));
  }

  const valid = loadRoleDefinitions(fileURLToPath(agents)).lead;
  const mismatch = structuredClone(valid);
  mismatch.deployment.opencode.policy.rules[0]!.binding.action = 'shell';
  const binding = compileOpenCodeRole(mismatch);
  assert.equal(binding.definition, undefined);
  assert.ok(binding.diagnostics.some(item => item.code === 'invalid-binding'));

  const inheritedBinding = structuredClone(valid);
  inheritedBinding.deployment.opencode.policy.rules[0]!.binding.action = 'constructor';
  const inheritedResult = compileOpenCodeRole(inheritedBinding);
  assert.ok(inheritedResult.diagnostics.some(item => item.code === 'unknown-capability'));
  assert.equal(inheritedResult.definition, undefined);

  const selector = structuredClone(valid.deployment.opencode.policy) as CapabilityPolicy;
  (selector.rules[0]!.resource as unknown as { kind: string }).kind = 'unmapped';
  const selectorResult = lowerOpenCodePolicy('lead', selector);
  assert.equal(selectorResult.permissions, undefined);
  assert.ok(selectorResult.diagnostics.some(item => item.code === 'unresolved-selector'));

  const unknownPrecedence = lowerOpenCodePolicy('lead', { schemaVersion: 1, rules: undefined } as unknown as CapabilityPolicy);
  assert.ok(unknownPrecedence.diagnostics.some(item => item.code === 'unresolved-precedence'));
});
