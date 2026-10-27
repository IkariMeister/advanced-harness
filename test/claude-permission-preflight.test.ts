import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeTempRoot } from './temp-directory.ts';
import { preflightClaudePermissions } from '../src/claude-permission-preflight.ts';
import { loadRoleDefinitions } from '../src/role-definitions.ts';
import { nativeRoles } from '../src/native-role-types.ts';
import { diagnoseHost } from '../src/native-diagnostics.ts';
import { clearRegisteredAdapters, registerHostAdapter, HOST_CAPABILITIES } from '../src/host-registry.ts';
import { runInstallerFlow } from '../src/installer-flow.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';

const agentsDirectory = fileURLToPath(new URL('../agents/', import.meta.url));

test('Claude preflight reports ordered precedence conflicts and role-indexed mapping uncertainties', () => {
  const definitions = loadRoleDefinitions(agentsDirectory);
  const before = JSON.stringify(definitions);
  const report = preflightClaudePermissions(definitions);
  assert.equal(report.host, 'claude-code');
  assert.equal(report.status, 'blocked');
  assert.equal(report.runtimeVerified, false);
  assert.equal(JSON.stringify(definitions), before);
  for (const role of nativeRoles) {
    const precedence = report.findings.find(item => item.code === 'precedence-conflict' && item.role === role);
    assert.ok(precedence, role);
    assert.ok(precedence.ruleIndexes.includes(0), role);
    assert.ok(precedence.ruleIndexes.some(index => index > 0), role);
    assert.ok(precedence.referenceUrls.includes('https://code.claude.com/docs/en/permissions'));
    const scope = report.findings.find(item => item.code === 'role-scope-unverified' && item.role === role);
    assert.deepEqual(scope?.ruleIndexes, definitions[role].deployment.opencode.policy.rules.map((_, index) => index));
  }
  const external = definitions.external.deployment.opencode.policy.rules;
  const capabilityCases: [string, string][] = [
    ['code-mode.execute', 'capability-mapping-unverified'],
    ['mcp.tool', 'capability-mapping-unverified'],
    ['agent.delegate', 'capability-mapping-unverified']
  ];
  for (const [capability, code] of capabilityCases) {
    const ruleIndex = external.findIndex(rule => rule.capability === capability);
    if (ruleIndex >= 0) assert.ok(report.findings.some(item => item.role === 'external' && item.code === code && item.ruleIndexes.includes(ruleIndex)), capability);
  }
  assert.ok(report.findings.some(item => item.code === 'selector-mapping-unverified' && item.ruleIndexes.includes(external.findIndex(rule => rule.resource.kind === 'native-pattern'))));
  assert.ok(report.findings.every(item => item.message.length > 0 && item.referenceUrls.length > 0));
  const mcpIndexes = external.flatMap((rule, index) => rule.capability === 'mcp.tool' ? [index] : []);
  assert.ok(mcpIndexes.length >= 2);
  const services = mcpIndexes.filter(index => /^(jira|github)_/.test(external[index]!.binding.action));
  assert.ok(services.length >= 2);
  assert.ok(report.findings.some(item => item.role === 'external' && item.code === 'capability-mapping-unverified' && services.every(index => item.ruleIndexes.includes(index))));
  const wildcardConflict = Object.fromEntries(nativeRoles.map(role => [role, {
    ...definitions[role],
    deployment: { opencode: { ...definitions[role].deployment.opencode, policy: { schemaVersion: 1 as const, resolution: 'ordered-last-match' as const, rules: role === 'lead' ? [
      { capability: 'all' as const, resource: { kind: 'all' as const }, effect: 'deny' as const, binding: { host: 'opencode' as const, action: '*' } },
      { capability: 'file.read' as const, resource: { kind: 'all' as const }, effect: 'allow' as const, binding: { host: 'opencode' as const, action: 'read' } }
    ] : [] } } }
  }])) as unknown as typeof definitions;
  const wildcardReport = preflightClaudePermissions(wildcardConflict);
  const exactConflict = wildcardReport.findings.find(item => item.role === 'lead' && item.code === 'precedence-conflict');
  assert.ok(exactConflict);
  assert.deepEqual(exactConflict.ruleIndexes, [0, 1]);
  const isolated = Object.fromEntries(nativeRoles.map(role => [role, {
    ...definitions[role],
    deployment: { opencode: { ...definitions[role].deployment.opencode, policy: { schemaVersion: 1 as const, resolution: 'ordered-last-match' as const, rules: role === 'external' ? [
      { capability: 'mcp.tool' as const, resource: { kind: 'all' as const }, effect: 'deny' as const, binding: { host: 'opencode' as const, action: 'jira_*' } },
      { capability: 'mcp.tool' as const, resource: { kind: 'all' as const }, effect: 'allow' as const, binding: { host: 'opencode' as const, action: 'github_*' } }
    ] : [] } } }
  }])) as unknown as typeof definitions;
  const isolatedReport = preflightClaudePermissions(isolated);
  assert.ok(!isolatedReport.findings.some(item => item.role === 'external' && item.code === 'precedence-conflict'));
  assert.ok(isolatedReport.findings.some(item => item.role === 'external' && item.code === 'capability-mapping-unverified'));
});

test('preflight reports no blockers only for an empty policy and never claims runtime verification', () => {
  const definitions = loadRoleDefinitions(agentsDirectory);
  const empty = Object.fromEntries(nativeRoles.map(role => [role, {
    ...definitions[role],
    deployment: {
      opencode: {
        ...definitions[role].deployment.opencode,
        policy: { schemaVersion: 1 as const, resolution: 'ordered-last-match' as const, rules: [] }
      }
    }
  }])) as unknown as typeof definitions;
  const report = preflightClaudePermissions(empty);
  assert.equal(report.status, 'no-blockers-detected');
  assert.deepEqual(report.findings, []);
  assert.equal(report.runtimeVerified, false);
});

test('Claude doctor separates source-policy blockers from installed footprint and runtime verification', async t => {
  const root = makeTempRoot('claude-policy-doctor-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const report = await diagnoseHost('claude-code', { project: root, home: root, agentsDirectory });
  assert.equal(report.installed, false);
  assert.equal(report.ok, false);
  assert.equal(report.sourcePolicy?.status, 'blocked');
  assert.equal(report.sourcePolicy?.runtimeVerified, false);
  assert.ok(report.notes.some(note => /separate from the installed configuration footprint/i.test(note)));
  assert.match(HOST_CAPABILITIES['claude-code'].ghPrMergeGuard, /Bash\(gh pr merge\)/);
  assert.ok(report.disclosures.some(note => /Project scope only/i.test(note)));
});

test('Claude doctor detects an explicitly supplied global configuration footprint', async t => {
  const root = makeTempRoot('claude-global-footprint-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  mkdirSync(home);
  writeFileSync(join(home, '.claude.json'), '{}\n');
  const report = await diagnoseHost('claude-code', { home, agentsDirectory });
  assert.equal(report.installed, true);
  assert.ok(report.notes.some(note => /configuration footprint detected/i.test(note)));
});

test('Claude single-host install/update dispatches to its adapter; mixed and unsupported selections fail closed', async t => {
  const root = makeTempRoot('claude-policy-flow-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const recovery = join(root, 'recovery');
  const calls: string[] = [];
  clearRegisteredAdapters();
  for (const host of ['claude-code', 'antigravity', 'codex', 'cursor'] as const) registerHostAdapter({
    host,
    install: async () => { calls.push(`install:${host}`); },
    update: async () => { calls.push(`update:${host}`); }
  });
  const ask = async () => 'no';
  try {
    assert.equal(await runInstallerFlow({ scope: 'project', project, host: 'claude-code' }, {
      ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, agentsDirectory
    }), 0);
    assert.equal(await runUpdateFlow({ scope: 'project', project, host: 'claude-code' }, {
      ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, agentsDirectory
    }), 0);
    assert.deepEqual(calls, ['install:claude-code', 'update:claude-code']);
    calls.length = 0;
    for (const host of ['opencode,claude-code', 'all', 'cursor', 'antigravity,codex']) {
      const installStatus = await runInstallerFlow({ scope: 'project', project, host }, {
        ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, agentsDirectory
      });
      assert.equal(installStatus, 2, `install ${host}`);
      const updateStatus = await runUpdateFlow({ scope: 'project', project, host }, {
        ask, output: () => {}, error: () => {}, home: root, recoveryDirectory: recovery, agentsDirectory
      });
      assert.equal(updateStatus, 2, `update ${host}`);
    }
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(project, 'opencode.json')), false);
    assert.equal(existsSync(join(project, 'opencode.jsonc')), false);
    assert.equal(existsSync(join(project, '.opencode', 'commands')), false);
    assert.equal(existsSync(recovery), false);
  } finally { clearRegisteredAdapters(); }
});
