import assert from 'node:assert/strict';
import { readdirSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './temp-directory.ts';
import test from 'node:test';
import { configurationField, createReceipt, modifyJsonc } from '../src/installation-receipt.ts';
import { loadNativeDefinitions, nativeRoles, parseConfiguration, updateNativeConfiguration } from '../src/native-installer.ts';
import { reconcilePermissions, type ReconciliationResult } from '../src/permission-reconciliation.ts';
import { previewPrFeedbackPermissions, prFeedbackPermissionRules, runPrFeedbackPermissionsFlow } from '../src/pr-feedback-permissions.ts';
import { createSuccessorReceipt, discoverReceiptChain, finalizeSuccessor, receiptReconciliationOptions, writePendingSuccessor } from '../src/receipt-lineage.ts';

const permissionPath = ['agents', 'external', 'permissions'];
const answer = 'add-pr-feedback-permissions';

function fixture(t: { after(fn: () => void): void }, denyView = false) {
  const root = makeTempRoot('pr-feedback-permissions-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configDirectory = join(root, 'opencode'); mkdirSync(configDirectory);
  const config = join(configDirectory, 'opencode.json');
  const recovery = join(root, 'recovery'); mkdirSync(recovery);
  const definitions = loadNativeDefinitions(join(process.cwd(), 'agents'));
  definitions.external.permissions = (definitions.external.permissions as { action: string; resource: string }[]).filter(rule =>
    !(rule.action === 'shell' && /^gh(?:\.exe)? pr view(?: \*)?$/.test(rule.resource)));
  const assignments = Object.fromEntries(nativeRoles.map(role => [role, definitions[role].model])) as Record<typeof nativeRoles[number], string>;
  const plans: Partial<Record<typeof nativeRoles[number], ReconciliationResult>> = {};
  const base = '{\n  "model": "custom/root",\n  "plugins": { "kept": true },\n  "agents": {}\n}\n';
  const installed = updateNativeConfiguration(base, definitions, assignments, false, false, [], { onPermissionPlan: (role, plan) => { plans[role] = plan; } });
  writeFileSync(config, installed);
  const empty = discoverReceiptChain(recovery, config);
  const installReceipt = createSuccessorReceipt(empty, undefined, installed, plans);
  finalizeSuccessor(writePendingSuccessor(empty, installReceipt), installed);

  const initialSnapshot = discoverReceiptChain(recovery, config);
  const current = readFileSync(config, 'utf8');
  const existing = configurationField(current, permissionPath) as { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }[];
  const prior = receiptReconciliationOptions(initialSnapshot).permissions!.external!;
  const fallback = [
    { action: 'shell', resource: 'gh *', effect: 'ask' as const },
    { action: 'shell', resource: 'gh.exe *', effect: 'ask' as const },
    { action: 'shell', resource: 'gh api *', effect: 'ask' as const },
    { action: 'shell', resource: 'gh.exe api *', effect: 'ask' as const },
    ...(denyView ? [{ action: 'shell', resource: 'gh pr view', effect: 'deny' as const }] : []),
  ];
  const setupPlan = reconcilePermissions({ existing, prior: prior.prior, previousOrder: prior.previousOrder,
    desired: fallback.map(rule => ({ rule, sources: ['integration:gh'] })) });
  assert.deepEqual(setupPlan.preview.conflicts, []);
  const withGhFallback = modifyJsonc(current, permissionPath, setupPlan.rules);
  writeFileSync(config, withGhFallback);
  const successorSnapshot = discoverReceiptChain(recovery, config);
  const successor = createSuccessorReceipt(successorSnapshot, current, withGhFallback, { external: setupPlan });
  finalizeSuccessor(writePendingSuccessor(successorSnapshot, successor), withGhFallback);
  return { root, config, recovery, definitions, installed: withGhFallback };
}

const recoveryEntries = (path: string) => readdirSync(path).sort();
const receiptFiles = (path: string) => recoveryEntries(path).filter(name => name.startsWith('native-install-'));

test('preview and approved apply add only four External view rules and preserve all unrelated configuration', async t => {
  const { config, recovery } = fixture(t);
  const before = readFileSync(config, 'utf8'); const beforeConfig = parseConfiguration(before, config);
  const beforeReceipts = receiptFiles(recovery);
  const preview = previewPrFeedbackPermissions(config, recovery);
  assert.deepEqual(preview.plan.preview.additions, prFeedbackPermissionRules);
  assert.equal(preview.updated !== before, true);
  assert.deepEqual(receiptFiles(recovery), beforeReceipts);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(createReceipt(config, before, preview.updated).changes.map(change => change.path), [permissionPath]);

  let prompt = '';
  const output: string[] = [];
  assert.equal(await runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
    ask: async question => { prompt = question; return answer; }, output: text => output.push(text), error: () => {},
  }), 0);
  assert.match(prompt, /after separate conversational approval/i);
  const after = readFileSync(config, 'utf8'); const afterConfig = parseConfiguration(after, config);
  const afterPermissions = configurationField(after, permissionPath) as { action: string; resource: string; effect: string }[];
  for (const rule of prFeedbackPermissionRules) assert.ok(afterPermissions.some(existing => JSON.stringify(existing) === JSON.stringify(rule)));
  assert.equal(afterPermissions.some(rule => rule.resource.startsWith('gh api') && rule.effect === 'allow'), false);
  assert.equal(afterPermissions.some(rule => rule.resource === 'gh pr merge' && rule.effect === 'deny'), true);
  assert.equal(afterPermissions.some(rule => rule.resource === 'gh *' && rule.effect === 'ask'), true);
  assert.equal(JSON.stringify(afterConfig.model), JSON.stringify(beforeConfig.model));
  assert.equal(JSON.stringify(afterConfig.plugins), JSON.stringify(beforeConfig.plugins));
  const beforeAgents = beforeConfig.agents as Record<string, Record<string, unknown>>;
  const afterAgents = afterConfig.agents as Record<string, Record<string, unknown>>;
  for (const role of nativeRoles) {
    if (role !== 'external') assert.deepEqual(afterAgents[role], beforeAgents[role], `${role} remains byte-equivalent as parsed settings`);
    else {
      const previous = structuredClone(beforeAgents.external!); const next = structuredClone(afterAgents.external!);
      delete previous.permissions; delete next.permissions;
      assert.deepEqual(next, previous);
    }
  }
  const chain = discoverReceiptChain(recovery, config);
  const nextReceipt = chain.head!.receipt;
  assert.equal(nextReceipt.version, 2);
  assert.equal(nextReceipt.status, 'complete');
  const priorReceipt = chain.entries.find(entry => entry.file !== chain.head!.file)!.receipt;
  assert.deepEqual(nextReceipt.changes.filter(change => change.path.join('.') !== 'agents.external.permissions'),
    priorReceipt.changes.filter(change => change.path.join('.') !== 'agents.external.permissions'));
  assert.deepEqual(nextReceipt.permissions.filter(entry => entry.path[1] !== 'external'), priorReceipt.version === 2 ? priorReceipt.permissions.filter(entry => entry.path[1] !== 'external') : []);
  const backupDirectories = recoveryEntries(recovery).filter(name => !name.startsWith('native-install-'));
  assert.equal(backupDirectories.length, 1);
  assert.equal(readFileSync(join(recovery, backupDirectories[0]!, 'opencode.json'), 'utf8'), before);
  assert.ok(output.some(line => line.startsWith('Private backup:')));
});

test('JSONC preview preserves comments, BOM, and CRLF while adding array entries', t => {
  const { config, recovery } = fixture(t);
  let before = readFileSync(config, 'utf8').replace(/\r?\n/g, '\r\n');
  const external = before.indexOf('"external": {');
  const permissionKey = before.indexOf('"permissions": [', external);
  const arrayStart = before.indexOf('[', permissionKey) + 1;
  const firstLineEnd = before.indexOf('\r\n', arrayStart) + 2;
  before = `${before.slice(0, firstLineEnd)}      // preserve this permission comment\r\n${before.slice(firstLineEnd)}`;
  before = before.replace('"model": "custom/root",', '// preserve this root comment\r\n  "model": "custom/root",');
  before = `\uFEFF${before}`;
  writeFileSync(config, before);

  const preview = previewPrFeedbackPermissions(config, recovery);
  assert.ok(preview.updated.startsWith('\uFEFF'));
  assert.ok(preview.updated.includes('// preserve this root comment'));
  assert.ok(preview.updated.includes('// preserve this permission comment'));
  assert.doesNotMatch(preview.updated.replace(/\r\n/g, ''), /\n/);
  const resulting = configurationField(preview.updated, permissionPath) as { action: string; resource: string; effect: string }[];
  for (const rule of prFeedbackPermissionRules) assert.ok(resulting.some(existing => JSON.stringify(existing) === JSON.stringify(rule)));
  assert.equal(readFileSync(config, 'utf8'), before);
});

test('cancellation writes nothing and a repeated preview/apply is an idempotent no-op', async t => {
  const { config, recovery } = fixture(t);
  const before = readFileSync(config, 'utf8'); const entries = recoveryEntries(recovery);
  assert.equal(await runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
    ask: async () => 'cancel', output: () => {}, error: () => {},
  }), 0);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(recoveryEntries(recovery), entries);

  assert.equal(await runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
    ask: async () => answer, output: () => {}, error: () => {},
  }), 0);
  const once = readFileSync(config, 'utf8'); const afterApplyEntries = recoveryEntries(recovery);
  let prompted = false;
  assert.equal(await runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
    ask: async () => { prompted = true; return answer; }, output: () => {}, error: () => {},
  }), 0);
  assert.equal(prompted, false);
  assert.equal(readFileSync(config, 'utf8'), once);
  assert.deepEqual(recoveryEntries(recovery), afterApplyEntries);
});

test('an explicit existing view deny conflicts without partial config or receipt writes', t => {
  const { config, recovery } = fixture(t, true);
  const before = readFileSync(config, 'utf8'); const entries = recoveryEntries(recovery);
  assert.throws(() => previewPrFeedbackPermissions(config, recovery), /Permission conflict/);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(recoveryEntries(recovery), entries);
});

test('configuration and receipt changes after preview stop before any write or backup', async t => {
  for (const change of ['config', 'receipt'] as const) {
    const { config, recovery } = fixture(t);
    const before = readFileSync(config, 'utf8'); const entries = recoveryEntries(recovery);
    await assert.rejects(runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
      ask: async () => {
        if (change === 'config') writeFileSync(config, `${before}\n`);
        else {
          const head = discoverReceiptChain(recovery, config).head!;
          writeFileSync(join(recovery, head.file), `${readFileSync(join(recovery, head.file), 'utf8')} `);
        }
        return answer;
      }, output: () => {}, error: () => {},
    }), change === 'config' ? /Configuration changed after preview/ : /Receipt evidence changed during review/);
    assert.deepEqual(recoveryEntries(recovery).filter(name => name.startsWith('native-install-')).filter(name => !name.includes('.tmp')), entries.filter(name => name.startsWith('native-install-')));
    assert.equal(recoveryEntries(recovery).some(name => !name.startsWith('native-install-')), false);
  }
});

test('failed config save clears only its uncommitted pending receipt when the original config remains', async t => {
  const { config, recovery } = fixture(t);
  const before = readFileSync(config, 'utf8'); const receipts = receiptFiles(recovery);
  await assert.rejects(runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
    ask: async () => answer, output: () => {}, error: () => {},
    save: () => { throw new Error('injected save failure'); },
  }), /injected save failure/);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(receiptFiles(recovery), receipts);
  assert.equal(recoveryEntries(recovery).some(name => !name.startsWith('native-install-')), false);
});

test('receipt finalization failure retains pending evidence and exact backup without retrying', async t => {
  const { config, recovery } = fixture(t);
  const before = readFileSync(config, 'utf8');
  const errors: string[] = [];
  await assert.rejects(runPrFeedbackPermissionsFlow({ target: config, recoveryDirectory: recovery, apply: true }, {
    ask: async () => answer, output: () => {}, error: message => errors.push(message),
    finalize: () => { throw new Error('injected finalization failure'); },
  }), /injected finalization failure/);
  assert.notEqual(readFileSync(config, 'utf8'), before);
  assert.ok(errors.some(message => message.includes('pending receipt retained')));
  const pendingName = receiptFiles(recovery).find(name => readFileSync(join(recovery, name), 'utf8').includes('"status": "pending"'));
  assert.ok(pendingName);
  const backupDirectory = recoveryEntries(recovery).find(name => !name.startsWith('native-install-'))!;
  assert.equal(readFileSync(join(recovery, backupDirectory, 'opencode.json'), 'utf8'), before);
});

test('CLI subprocess help, argument parsing, default preview, and non-TTY apply refusal never write', t => {
  const { config, recovery } = fixture(t);
  const script = fileURLToPath(new URL('../scripts/add-pr-feedback-permissions.ts', import.meta.url));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: 'utf8' });
  const before = readFileSync(config, 'utf8'); const entries = recoveryEntries(recovery);

  const help = invoke('--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Default mode is read-only preview/);
  assert.deepEqual(recoveryEntries(recovery), entries);

  const invalid = invoke('--config', config, '--unexpected');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown, duplicate, or incomplete option/);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(recoveryEntries(recovery), entries);

  const preview = invoke('--config', config, '--recovery-directory', recovery);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Read-only preview only/);
  for (const rule of prFeedbackPermissionRules) assert.ok(preview.stdout.includes(JSON.stringify(rule)));
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(recoveryEntries(recovery), entries);

  const nonTtyApply = invoke('--config', config, '--recovery-directory', recovery, '--apply');
  assert.notEqual(nonTtyApply.status, 0);
  assert.match(nonTtyApply.stderr, /--apply requires an interactive terminal/);
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.deepEqual(recoveryEntries(recovery), entries);
});
