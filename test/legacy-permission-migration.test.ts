import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './temp-directory.ts';
import { runUpdateFlow } from '../src/update-cli-flow.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';
import { createReceipt, planUninstall, readInstallationReceipt, writeInstallationReceipt } from '../src/installation-receipt.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, validateV2Receipt, writePendingSuccessor } from '../src/receipt-lineage.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration, type NativeRole } from '../src/native-installer.ts';
import { reconcilePermissions, type PermissionRule, type ReconciliationResult } from '../src/permission-reconciliation.ts';
import { planLegacyPermissionMigration } from '../src/legacy-permission-migration.ts';

const definitions = loadNativeDefinitions(join(process.cwd(), 'agents'));
const shell = (resource: string, effect: PermissionRule['effect']): PermissionRule => ({ action: 'shell', resource, effect });
const legacyFetch = shell('git fetch *', 'deny');
const duplicate = shell('gh *', 'deny');
// A pre-receipt Operator array: the older policy, which denied the `git fetch *` the
// current policy allows, with one rule repeated.
const legacyOperator: PermissionRule[] = [
  ...(definitions.operator.permissions as PermissionRule[])
    .filter(rule => !(rule.action === 'shell' && rule.resource.startsWith('git fetch') && rule.resource !== 'git fetch *'))
    .map(rule => rule.action === 'shell' && rule.resource === 'git fetch *' ? legacyFetch : rule),
  duplicate
];
assert.ok(legacyOperator.filter(rule => JSON.stringify(rule) === JSON.stringify(duplicate)).length === 2);

function agentsWith(operator: PermissionRule[]) {
  return {
    agents: Object.fromEntries(nativeRoles.map(role => [role, {
      description: definitions[role].description,
      mode: definitions[role].mode,
      model: 'custom/model#low',
      system: definitions[role].system,
      permissions: role === 'operator' ? operator : []
    }]))
  };
}

/**
 * A v1 legacy install, a hand cleanup of the duplicate, then a v2 successor that keeps
 * the arrays as opaque evidence: the recorded legacy state is now stale.
 */
function legacyInstall(t: test.TestContext) {
  const root = makeTempRoot('harness-legacy-migration-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const config = join(project, 'opencode.json');
  const recovery = join(root, 'recovery');
  const installed = JSON.stringify(agentsWith(legacyOperator), null, 2);
  mkdirSync(recovery);
  writeInstallationReceipt(recovery, createReceipt(config, '{}', installed));
  const cleanedOperator = legacyOperator.slice(0, -1);
  const cleaned = JSON.stringify(agentsWith(cleanedOperator), null, 2);
  writeFileSync(config, cleaned);
  const chain = discoverReceiptChain(recovery, config, 'opencode');
  const plans = Object.fromEntries(nativeRoles.map(role => [role, reconcilePermissions({ existing: role === 'operator' ? cleanedOperator : [], desired: [] })])) as Record<NativeRole, ReconciliationResult>;
  finalizeSuccessor(writePendingSuccessor(chain, createSuccessorReceipt(chain, cleaned, cleaned, plans, undefined, { host: 'opencode' })), cleaned);
  return { root, project, config, recovery, cleaned };
}

const snapshotFiles = (directory: string) => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name), 'utf8')] as const);
const headPath = (recovery: string, config: string) => join(recovery, discoverReceiptChain(recovery, config, 'opencode').head!.file);

async function update(fixture: ReturnType<typeof legacyInstall>, answers: { migrate: string; final?: string }) {
  const questions: string[] = [], output: string[] = [], errors: string[] = [];
  const status = await runUpdateFlow({ scope: 'project', project: fixture.project, checkRemote: false }, {
    ask: async question => {
      questions.push(question);
      if (question.startsWith('Type migrate')) return answers.migrate;
      if (question.startsWith('Choose new models')) return 'no';
      if (question.startsWith('Type update')) return answers.final ?? 'cancel';
      throw new Error(`Unexpected prompt: ${question}`);
    },
    output: text => output.push(text), error: text => errors.push(text),
    home: fixture.root, recoveryDirectory: fixture.recovery,
    runCommand: (_cmd, args) => args[0] === 'rev-parse' ? '1111222233334444' : '',
    verify: async () => ({ ok: true, checks: [] } as never), printReport: () => {}
  });
  return { status, questions, output, errors };
}

test('uninstall of stale legacy evidence points at the migration and writes nothing', async t => {
  const fixture = legacyInstall(t);
  const errors: string[] = [];
  const status = await runUninstallFlow({
    receipt: readInstallationReceipt(headPath(fixture.recovery, fixture.config), fixture.config), current: fixture.cleaned,
    confirm: async () => assert.fail('no confirmation on conflict'), output: () => {}, error: text => errors.push(text),
    save: () => assert.fail('no save on conflict')
  });
  assert.equal(status, 1);
  assert.ok(errors.some(line => line.includes('agents.operator.permissions (opaque legacy array)')), errors.join('\n'));
  assert.ok(errors.some(line => line.includes('type migrate')), errors.join('\n'));
});

test('skipping the legacy migration keeps update blocked with no writes', async t => {
  const fixture = legacyInstall(t);
  const before = snapshotFiles(fixture.recovery);
  for (const answer of ['', 'skip', 'yes']) {
    const result = await update(fixture, { migrate: answer });
    assert.equal(result.status, 2);
    assert.ok(result.output.some(line => line.includes(`replace legacy ${JSON.stringify(legacyFetch)}`)), result.output.join('\n'));
    assert.ok(result.output.some(line => line.includes(`no longer present ${JSON.stringify(duplicate)}`)));
    assert.ok(result.errors.some(line => line.includes('[operator] identity: Conflicting existing permission rule shell git fetch *.')), result.errors.join('\n'));
    assert.ok(!result.questions.some(question => question.startsWith('Type update')));
  }
  assert.equal(readFileSync(fixture.config, 'utf8'), fixture.cleaned);
  assert.deepEqual(snapshotFiles(fixture.recovery), before);
  assert.equal(existsSync(join(fixture.project, '.opencode', 'commands')), false);
});

test('cancelling the final confirmation after migrate writes nothing', async t => {
  const fixture = legacyInstall(t);
  const before = snapshotFiles(fixture.recovery);
  const result = await update(fixture, { migrate: 'migrate', final: 'cancel' });
  assert.equal(result.status, 0);
  assert.ok(result.output.includes('Update cancelled. No files or receipts were modified.'));
  assert.equal(readFileSync(fixture.config, 'utf8'), fixture.cleaned);
  assert.deepEqual(snapshotFiles(fixture.recovery), before);
  assert.equal(existsSync(join(fixture.project, '.opencode', 'commands')), false);
});

test('consented migration applies the current policy and lets uninstall restore cleanly', async t => {
  const fixture = legacyInstall(t);
  const result = await update(fixture, { migrate: 'migrate', final: 'update' });
  assert.equal(result.status, 0, result.errors.join('\n'));
  const saved = readFileSync(fixture.config, 'utf8');
  const operator = (parseConfiguration(saved, fixture.config).agents as Record<string, { permissions: PermissionRule[] }>).operator!.permissions;
  assert.ok(operator.some(rule => rule.action === 'shell' && rule.resource === 'git fetch *' && rule.effect === 'allow'));
  assert.ok(!operator.some(rule => JSON.stringify(rule) === JSON.stringify(legacyFetch)));

  const head = readInstallationReceipt(headPath(fixture.recovery, fixture.config), fixture.config);
  assert.equal(head.version, 2);
  const evidence = head.version === 2 ? head.permissions.find(p => p.path[1] === 'operator')! : undefined;
  assert.deepEqual(evidence?.legacyMigration?.replaced, [legacyFetch]);
  assert.deepEqual(evidence?.legacyMigration?.from, { value: legacyOperator });

  // Nothing stale is left to offer, and uninstall restores the pre-install state.
  assert.deepEqual(planLegacyPermissionMigration(discoverReceiptChain(fixture.recovery, fixture.config, 'opencode'), parseConfiguration(saved, fixture.config), definitions), []);
  const restore = planUninstall(head, saved);
  assert.deepEqual(restore.conflicts, []);
  assert.equal((parseConfiguration(restore.updated, fixture.config).agents as Record<string, Record<string, unknown>> | undefined)?.operator?.permissions, undefined);

  // A later update inherits the refreshed evidence without repeating the migration.
  const next = await update(fixture, { migrate: 'unexpected', final: 'update' });
  assert.equal(next.status, 0, next.errors.join('\n'));
  assert.ok(!next.questions.some(question => question.startsWith('Type migrate')));
  const latest = readInstallationReceipt(headPath(fixture.recovery, fixture.config), fixture.config);
  assert.equal(latest.version === 2 && latest.permissions.find(p => p.path[1] === 'operator')!.legacyMigration, undefined);
});

test('receipt lineage rejects opaque evidence changed without migration evidence', async t => {
  const fixture = legacyInstall(t);
  assert.equal((await update(fixture, { migrate: 'migrate', final: 'update' })).status, 0);
  const path = headPath(fixture.recovery, fixture.config);
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  const operator = receipt.permissions.find((p: { path: string[] }) => p.path[1] === 'operator');
  delete operator.legacyMigration;
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
  assert.throws(() => discoverReceiptChain(fixture.recovery, fixture.config, 'opencode'), /Successor changed opaque legacy evidence/);
});

test('migration never replaces a rule from before the first install', t => {
  const root = makeTempRoot('harness-legacy-baseline-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'opencode.json');
  const userRule = shell('git fetch *', 'deny');
  const before = JSON.stringify({ agents: { operator: { permissions: [userRule] } } });
  const installed = JSON.stringify({ agents: { operator: { permissions: [userRule, shell('*', 'ask')] } } });
  writeInstallationReceipt(root, createReceipt(config, before, installed));
  const chain = discoverReceiptChain(root, config, 'opencode');
  const current = parseConfiguration(installed, config);
  // The user's own deny conflicts with the policy but is not legacy-installer evidence.
  assert.deepEqual(planLegacyPermissionMigration(chain, current, definitions), []);
  const plan = reconcilePermissions({ existing: [userRule, shell('*', 'ask')], desired: [] });
  const forged = createSuccessorReceipt(chain, installed, installed, { operator: plan });
  const operator = forged.permissions.find(p => p.path[1] === 'operator')!;
  operator.legacyMigration = { from: operator.opaque!.after, replaced: [userRule] };
  assert.throws(() => validateV2Receipt(forged, config), /Invalid legacy permission migration evidence/);
  assert.throws(() => createSuccessorReceipt(chain, installed, installed, {}, undefined, { legacyMigrations: { operator: [] } }), /requires opaque legacy evidence and planner provenance/);
});
