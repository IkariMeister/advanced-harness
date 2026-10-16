import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, receiptReconciliationOptions, recoverFailedSuccessor, revalidatePendingSuccessor, writePendingSuccessor } from '../src/receipt-lineage.ts';
import { adoptExisting, createReceipt, planUninstall, readInstallationReceipt, writeAdoptionReceipt, writeInstallationReceipt } from '../src/installation-receipt.ts';
import { reconcilePermissions, type PermissionRule, type ReconciliationResult } from '../src/permission-reconciliation.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration, updateNativeConfiguration, type NativeRole } from '../src/native-installer.ts';
import { updateConnectionConfig } from '../src/integration-setup.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-lineage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, target: join(directory, 'opencode.jsonc') };
}
const rule = (resource: string): PermissionRule => ({ action: 'shell', resource, effect: 'ask' });
const config = (rules: PermissionRule[], system = 'managed') => JSON.stringify({ agents: { lead: { system, permissions: rules } } });

test('two finalized successors retain original baseline, shared sources and active-head restore', async t => {
  const { directory, target } = fixture(t);
  const a = rule('a'), b = rule('b'), user = rule('user');
  const firstPlan = reconcilePermissions({ existing: [], desired: [{ rule: a, sources: ['native:lead'] }] });
  const initial = discoverReceiptChain(directory, target);
  const first = createSuccessorReceipt(initial, undefined, config([a]), { lead: firstPlan });
  const pending = writePendingSuccessor(initial, first);
  assert.throws(() => discoverReceiptChain(directory, target), /Pending/);
  assert.throws(() => planUninstall(readInstallationReceipt(pending.path, target, true), config([a])), /Pending receipt/);
  writeFileSync(target, config([a])); finalizeSuccessor(pending, config([a]));
  const snapshot = discoverReceiptChain(directory, target);
  const options = receiptReconciliationOptions(snapshot);
  const secondPlan = reconcilePermissions({ existing: [a], desired: [{ rule: a, sources: ['integration:github'] }, { rule: b, sources: ['integration:github'] }], ...options.permissions!.lead });
  const second = createSuccessorReceipt(snapshot, config([a]), config([a, b], 'updated'), { lead: secondPlan });
  assert.deepEqual(second.changes.find(c => c.path.at(-1) === 'system')?.before, { absent: true });
  const next = writePendingSuccessor(snapshot, second);
  writeFileSync(target, config([a, b], 'updated')); finalizeSuccessor(next, config([a, b], 'updated'));
  assert.throws(() => readInstallationReceipt(pending.path, target), /Superseded/);
  assert.throws(() => readInstallationReceipt(pending.path, target, true), /Superseded/);
  const activeReceipt = readInstallationReceipt(next.path, target);
  let saved: string | undefined;
  const cancelledStatus = await runUninstallFlow({ receipt: activeReceipt, current: config([a, b, user], 'updated'), confirm: async () => 'cancel', output: () => {}, error: message => assert.fail(message), save: updated => { saved = updated; } });
  assert.equal(cancelledStatus, 0);
  assert.equal(saved, undefined);
  let errorMsg = '';
  const conflictStatus = await runUninstallFlow({ receipt: activeReceipt, current: config([a, a, b], 'updated'), confirm: async () => assert.fail('should not confirm on conflict'), output: () => {}, error: message => { errorMsg = message; }, save: () => assert.fail('should not save on conflict') });
  assert.equal(conflictStatus, 1);
  assert.match(errorMsg, /Uninstall blocked by concurrent edits/);
  const status = await runUninstallFlow({ receipt: activeReceipt, current: config([a, b, user], 'updated'), confirm: async () => 'uninstall', output: () => {}, error: message => assert.fail(message), save: updated => { saved = updated; } });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(saved!), { agents: { lead: { permissions: [user] } } });
});

test('pending finalization failure leaves predecessor unsuperseded and pending evidence intact', t => {
  const { directory, target } = fixture(t);
  const snapshot = discoverReceiptChain(directory, target);
  const receipt = createSuccessorReceipt(snapshot, '{}', '{"model":"p/m"}', {});
  const pending = writePendingSuccessor(snapshot, receipt);
  writeFileSync(target, '{"model":"user/change"}');
  assert.throws(() => finalizeSuccessor(pending, '{"model":"p/m"}'), /Configuration changed/);
  assert.equal(JSON.parse(readFileSync(pending.path, 'utf8')).status, 'pending');
  assert.throws(() => discoverReceiptChain(directory, target), /Pending/);
});

test('legacy arrays remain opaque while new v2 additions receive attributable evidence', t => {
  const { directory, target } = fixture(t);
  const a = rule('legacy'), b = rule('new'), user = rule('user');
  const before = config([], 'original'), installed = config([a]);
  const legacyPath = writeInstallationReceipt(directory, createReceipt(target, before, installed));
  const snapshot = discoverReceiptChain(directory, target);
  const plan = reconcilePermissions({ existing: [a], desired: [{ rule: b, sources: ['integration'] }] });
  const next = createSuccessorReceipt(snapshot, installed, config([a, b]), { lead: plan });
  assert.deepEqual(next.permissions[0]!.owned.map(o => o.rule), [b]);
  const pending = writePendingSuccessor(snapshot, next);
  writeFileSync(target, config([a, b])); finalizeSuccessor(pending, config([a, b]));
  assert.throws(() => readInstallationReceipt(legacyPath, target), /Superseded/);
  const loaded = readInstallationReceipt(pending.path, target);
  assert.deepEqual(JSON.parse(planUninstall(loaded, config([a, b])).updated), JSON.parse(before));
  const edited = config([a, b, user]);
  const conflict = planUninstall(loaded, edited);
  assert.ok(conflict.conflicts.some(c => c.includes('opaque')));
  assert.equal(conflict.updated, edited);
});

test('missing, altered, duplicate and forked receipt evidence fails closed', t => {
  const { directory, target } = fixture(t);
  const oldPath = writeInstallationReceipt(directory, createReceipt(target, '{}', '{"model":"p/old"}'));
  const original = readFileSync(oldPath, 'utf8');
  const snapshot = discoverReceiptChain(directory, target);
  const next = createSuccessorReceipt(snapshot, '{"model":"p/old"}', '{"model":"p/new"}', {});
  const pending = writePendingSuccessor(snapshot, next);
  writeFileSync(target, '{"model":"p/new"}'); finalizeSuccessor(pending, '{"model":"p/new"}');
  writeFileSync(oldPath, original + ' ');
  assert.throws(() => discoverReceiptChain(directory, target), /altered/);
  unlinkSync(oldPath); assert.throws(() => discoverReceiptChain(directory, target), /Missing/);
  writeFileSync(oldPath, original);
  const duplicate = join(directory, 'native-install-copy.json');
  writeFileSync(duplicate, readFileSync(pending.path));
  assert.throws(() => discoverReceiptChain(directory, target), /Duplicate/);
  writeFileSync(duplicate, JSON.stringify({ ...next, id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
  assert.throws(() => discoverReceiptChain(directory, target), /Forked/);
});

test('receipt inventory is revalidated before pending writes, config save, and restore', t => {
  const { directory, target } = fixture(t);
  const snapshot = discoverReceiptChain(directory, target);
  const receipt = createSuccessorReceipt(snapshot, '{}', '{"model":"p/new"}', {});
  const pending = writePendingSuccessor(snapshot, receipt);
  writeFileSync(pending.path, pending.text + ' ');
  assert.throws(() => revalidatePendingSuccessor(pending), /Pending receipt changed/);
  writeFileSync(pending.path, pending.text);
  writeFileSync(target, '{"model":"p/new"}'); finalizeSuccessor(pending, '{"model":"p/new"}');
  const loaded = readInstallationReceipt(pending.path, target);
  writeFileSync(pending.path, readFileSync(pending.path, 'utf8') + ' ');
  assert.throws(() => planUninstall(loaded, '{"model":"p/new"}'), /evidence changed/);
  assert.throws(() => writePendingSuccessor(snapshot, receipt), /evidence changed/);
});

test('ambiguous managed-rule duplicates and movement prevent any restore', t => {
  const { directory, target } = fixture(t);
  const a = rule('a'), b = rule('b');
  const snapshot = discoverReceiptChain(directory, target);
  const plan = reconcilePermissions({ existing: [], desired: [a, b].map(rule => ({ rule, sources: ['native'] })) });
  const receipt = createSuccessorReceipt(snapshot, '{}', config([a, b]), { lead: plan });
  const pending = writePendingSuccessor(snapshot, receipt);
  writeFileSync(target, config([a, b])); finalizeSuccessor(pending, config([a, b]));
  const loaded = readInstallationReceipt(pending.path, target);
  for (const text of [config([a, a, b]), config([b, a])]) {
    const restore = planUninstall(loaded, text);
    assert.ok(restore.conflicts.length); assert.equal(restore.updated, text);
  }
});

test('real native installation, integration setup, customized upgrade and cumulative restore compose', t => {
  const { directory, target } = fixture(t);
  const definitions = loadNativeDefinitions(fileURLToPath(new URL('../agents/', import.meta.url)));
  const assignments = Object.fromEntries(nativeRoles.map(role => [role, definitions[role].model])) as Record<NativeRole, string>;
  let current = '{"custom":"preserve"}';
  const apply = (operation: (options: ReturnType<typeof receiptReconciliationOptions>) => string) => {
    const snapshot = discoverReceiptChain(directory, target);
    const options = receiptReconciliationOptions(snapshot);
    const plans: Partial<Record<NativeRole, ReconciliationResult>> = {};
    options.onPermissionPlan = (role, plan) => { plans[role] = plan; };
    const after = operation(options);
    const receipt = createSuccessorReceipt(snapshot, current, after, plans);
    const pending = writePendingSuccessor(snapshot, receipt);
    writeFileSync(target, after); finalizeSuccessor(pending, after);
    current = after;
    return pending.path;
  };
  apply(options => updateNativeConfiguration(current, definitions, assignments, false, false, [], options));
  apply(options => updateConnectionConfig(current, [{ path: target, text: current, value: parseConfiguration(current, target) }], [{ name: 'customjira', create: { type: 'remote', url: 'https://example.test/mcp', disabled: true } }], true, options));
  const customized = JSON.parse(current);
  customized.agents.lead.color = 'purple';
  customized.agents.lead.model = { providerID: 'company', model: 'custom', variant: 'low' };
  customized.agents.lead.permissions.push(rule('user command'));
  current = JSON.stringify(customized);
  // Model customizations are preserved during upgrade and intentionally conflict on restore.
  const upgraded = { ...definitions, lead: { ...definitions.lead, system: 'new managed system' } };
  const head = apply(options => updateNativeConfiguration(current, upgraded, assignments, false, false, [], options));
  assert.deepEqual(JSON.parse(current).agents.lead.model, customized.agents.lead.model);
  const loaded = readInstallationReceipt(head, target);
  const blocked = planUninstall(loaded, current);
  assert.ok(blocked.conflicts.includes('agents.lead.model'));
  assert.equal(blocked.updated, current);
  const resolved = JSON.parse(current); resolved.agents.lead.model = definitions.lead.model;
  const restored = planUninstall(loaded, JSON.stringify(resolved));
  assert.deepEqual(restored.conflicts, []);
  const value = JSON.parse(restored.updated);
  assert.deepEqual(value.agents, { lead: { color: 'purple', permissions: [rule('user command')] } });
  assert.equal(value.custom, 'preserve');
  assert.equal(value.mcp.servers.customjira.disabled, true);
});

test('failed-save cleanup never discards changed receipt evidence', t => {
  const { directory, target } = fixture(t);
  const snapshot = discoverReceiptChain(directory, target);
  const receipt = createSuccessorReceipt(snapshot, undefined, '{"model":"p/new"}', {});
  const pending = writePendingSuccessor(snapshot, receipt);
  writeFileSync(pending.path, pending.text + ' ');
  assert.equal(recoverFailedSuccessor(pending, undefined), 'retained');
  writeFileSync(pending.path, pending.text);
  assert.equal(recoverFailedSuccessor(pending, undefined), 'cleared');
  assert.equal(discoverReceiptChain(directory, target).head, undefined);
});

test('v1 adopted baselines extend to v2 without adopting unknown permissions or containers', t => {
  const { directory, target } = fixture(t);
  const original = config([rule('user')], 'before');
  const adopted = config([rule('user')], 'adopted');
  const path = writeAdoptionReceipt(directory, adoptExisting(target, adopted, original, ['agents.lead.system'], [], []));
  const snapshot = discoverReceiptChain(directory, target);
  const next = config([rule('user')], 'new');
  const receipt = createSuccessorReceipt(snapshot, adopted, next, {});
  assert.deepEqual(receipt.createdContainers, []);
  assert.deepEqual(receipt.permissions, []);
  const pending = writePendingSuccessor(snapshot, receipt);
  writeFileSync(target, next); finalizeSuccessor(pending, next);
  assert.throws(() => readInstallationReceipt(path, target), /Superseded/);
  assert.deepEqual(JSON.parse(planUninstall(readInstallationReceipt(pending.path, target), next).updated), JSON.parse(original));
});

test('v2 rule restore preserves BOM, CRLF and unrelated comments', t => {
  const { directory, target } = fixture(t);
  const a = rule('managed');
  const snapshot = discoverReceiptChain(directory, target);
  const after = '\uFEFF{\r\n// user comment\r\n"agents":{"lead":{"permissions":' + JSON.stringify([a]) + '}},\r\n"custom":true\r\n}\r\n';
  const plan = reconcilePermissions({ existing: [], desired: [{ rule: a, sources: ['native:lead'] }] });
  const receipt = createSuccessorReceipt(snapshot, '{"custom":true}', after, { lead: plan });
  const pending = writePendingSuccessor(snapshot, receipt);
  writeFileSync(target, after); finalizeSuccessor(pending, after);
  const restored = planUninstall(readInstallationReceipt(pending.path, target), after);
  assert.deepEqual(restored.conflicts, []);
  assert.ok(restored.updated.startsWith('\uFEFF'));
  assert.match(restored.updated, /user comment/);
  assert.ok(!restored.updated.replaceAll('\r\n', '').includes('\n'));
  assert.deepEqual(parseConfiguration(restored.updated, target), { custom: true });
});

test('unrelated heads, pending overlaps and cyclic references are rejected', t => {
  const { directory, target } = fixture(t);
  writeInstallationReceipt(directory, createReceipt(target, '{}', '{"model":"p/m"}'));
  const other = writeInstallationReceipt(directory, createReceipt(target, '{}', '{"default_agent":"lead"}'));
  assert.throws(() => discoverReceiptChain(directory, target), /unrelated/);
  unlinkSync(other);
  const snapshot = discoverReceiptChain(directory, target);
  const receipt = createSuccessorReceipt(snapshot, '{"model":"p/m"}', '{"model":"p/n"}', {});
  const pending = writePendingSuccessor(snapshot, receipt);
  assert.throws(() => discoverReceiptChain(directory, target), /Pending/);
  writeFileSync(pending.path, JSON.stringify({ ...receipt, predecessor: { file: pending.path.split(/[\\/]/).at(-1), identity: receipt.id, digest: '0'.repeat(64) } }));
  assert.throws(() => discoverReceiptChain(directory, target), /altered|Cyclic/);
});
