import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTempRoot } from './temp-directory.ts';
import { adoptExisting, assertNoReceiptOverlap, completePendingReceipt, configurationField, createReceipt, persistAdoptionReceipt, planUninstall, readInstallationReceipt, recoverFailedInstallation, writeInstallationReceipt, writePendingReceipt } from '../src/installation-receipt.ts';
import { parseConfiguration } from '../src/native-installer.ts';
import { runUninstallFlow } from '../src/uninstall-cli-flow.ts';

test('uninstall CLI documents scoped receipt discovery and validates scope arguments', () => {
  const script = join(process.cwd(), 'scripts', 'uninstall-native-harness.ts');
  const help = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.match(help, /--scope global\|project/);
  assert.match(help, /--receipt/);
  assert.throws(() => execFileSync(process.execPath, [script, '--scope', 'other'], { stdio: 'pipe' }), /--scope must be global or project/);
  assert.throws(() => execFileSync(process.execPath, [script, '--scope', 'project'], { stdio: 'pipe' }), /--project is required/);
});

test('uninstall CLI discovers configuration across global jsonc and project locations', () => {
  const root = makeTempRoot('harness-uninstall-target-');
  const script = join(process.cwd(), 'scripts', 'uninstall-native-harness.ts');
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');

  // Test Case 1: Global scope with opencode.jsonc
  const globalDir = join(xdg, 'opencode');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, 'opencode.jsonc'), '{"model":"global/test"}');

  // Running without TTY should fail with "Interactive terminal required", proving it resolved target correctly
  assert.throws(
    () => execFileSync(process.execPath, [script, '--scope', 'global'], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      stdio: 'pipe',
    }),
    /Interactive terminal required/
  );

  // Test Case 2: Project scope with project-root opencode.jsonc
  const projectRootOnly = join(root, 'project-root');
  mkdirSync(projectRootOnly, { recursive: true });
  writeFileSync(join(projectRootOnly, 'opencode.jsonc'), '{"model":"project/test"}');

  assert.throws(
    () => execFileSync(process.execPath, [script, '--scope', 'project', '--project', projectRootOnly], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      stdio: 'pipe',
    }),
    /Interactive terminal required/
  );

  // Test Case 3: Project scope with project .opencode/opencode.json
  const projectNested = join(root, 'project-nested');
  const dotOpencode = join(projectNested, '.opencode');
  mkdirSync(dotOpencode, { recursive: true });
  writeFileSync(join(dotOpencode, 'opencode.json'), '{"model":"nested/test"}');

  assert.throws(
    () => execFileSync(process.execPath, [script, '--scope', 'project', '--project', projectNested], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
      stdio: 'pipe',
    }),
    /Interactive terminal required/
  );

  rmSync(root, { recursive: true, force: true });
});

test('receipt-backed plan restores changed supported fields and preserves unmanaged settings', () => {
  const before = '{\r\n  // retained\r\n  "custom": [1,2],\r\n  "agents": {"lead": {"color":"blue","model":"old/model"}}\r\n}\r\n';
  const after = before.replace('"old/model"', '"new/model"');
  const receipt = createReceipt('opencode.jsonc', before, after);
  assert.equal(receipt.complete, true);
  const plan = planUninstall(receipt, after);
  assert.deepEqual(plan.conflicts, []);
  assert.match(plan.updated, /"old\/model"/);
  assert.match(plan.updated, /"color":"blue"/);
  assert.match(plan.updated, /"custom": \[1,2\]/);
});

test('receipt restore preserves BOM, CRLF, comments, unmanaged fields, and exact before bytes', () => {
  const target = 'opencode.jsonc';
  const before = '\uFEFF{\r\n  // retained comment\r\n  "model": "provider/old",\r\n  "custom": {"keep": true}\r\n}\r\n';
  const after = before.replace('provider/old', 'provider/new');
  const plan = planUninstall(createReceipt(target, before, after), after);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.updated.charCodeAt(0), 0xfeff);
  assert.match(plan.updated, /\r\n/);
  assert.match(plan.updated, /retained comment/);
  assert.match(plan.updated, /"custom": \{"keep": true\}/);
  assert.equal(plan.updated, before);
});

test('receipt is private, versioned, target-bound and malformed/foreign receipts fail closed', t => {
  const root = makeTempRoot('harness-receipt-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipt = createReceipt(join(root, 'opencode.jsonc'), '{}', '{"model":"provider/model"}');
  const path = writeInstallationReceipt(root, receipt);
  assert.equal(readInstallationReceipt(path, receipt.target).complete, true);
  assert.throws(() => readInstallationReceipt(path, join(root, 'other.jsonc')), /different configuration/);
  const malformed = join(root, 'bad.json'); writeFileSync(malformed, '{');
  assert.throws(() => readInstallationReceipt(malformed, receipt.target), /Malformed/);
  assert.ok((readFileSync(path).length) > 0);
});

test('conflicting edits block whole receipt-backed mutation', () => {
  const receipt = createReceipt('opencode.jsonc', '{"model":"old/model"}', '{"model":"new/model"}');
  const plan = planUninstall(receipt, '{"model":"user/model"}');
  assert.deepEqual(plan.conflicts, ['model']);
  assert.equal(plan.updated, '{"model":"user/model"}');
});

test('expanded model evidence survives receipt persistence and restores its original representation', t => {
  const root = makeTempRoot('harness-model-receipt-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.jsonc');
  const model = { providerID: 'company', model: 'original', variant: 'low', custom: 'preserve' };
  const before = JSON.stringify({ agents: { lead: { model } } });
  const after = JSON.stringify({ agents: { lead: { model: 'company/replacement#medium' } } });
  const receipt = readInstallationReceipt(writeInstallationReceipt(root, createReceipt(target, before, after)), target);
  const plan = planUninstall(receipt, after);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(configurationField(plan.updated, ['agents', 'lead', 'model']), model);
});

test('CLI conflict flow reports exact stderr, exits 1, and never prompts or saves', async () => {
  const current = '{"model":"user/model"}';
  const receipt = createReceipt('opencode.jsonc', '{"model":"old/model"}', '{"model":"new/model"}');
  const errors: string[] = [], outputs: string[] = [];
  let prompted = false, saved = false, closed = false;
  const status = await runUninstallFlow({
    receipt, current,
    confirm: async () => { prompted = true; throw new Error('must not prompt'); },
    output: message => outputs.push(message),
    error: message => errors.push(message),
    save: () => { saved = true; },
  }).finally(() => { closed = true; });
  assert.equal(status, 1);
  assert.deepEqual(errors, ['Uninstall blocked by concurrent edits to: model. No fields changed.']);
  assert.deepEqual(outputs, []);
  assert.equal(prompted, false);
  assert.equal(saved, false);
  assert.equal(closed, true);
});

test('CLI flow propagates unexpected planning errors', async () => {
  const errors: string[] = [];
  const receipt = createReceipt('opencode.jsonc', '{"model":"old"}', '{"model":"new"}');
  await assert.rejects(runUninstallFlow({
    receipt, current: 'not-json', confirm: async () => '', output: () => {},
    error: message => errors.push(message), save: () => {},
  }));
  assert.deepEqual(errors, []);
});

test('supported receipt fields roundtrip and dangling default-agent restoration blocks the entire plan', t => {
  const root = makeTempRoot('harness-receipt-paths-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json');
  const before = JSON.stringify({ model: 'old/provider', default_agent: 'lead', agents: { lead: { description: 'prior', mode: 'all', model: 'old/provider', permissions: [], system: 'prior' } } });
  const after = JSON.stringify({ model: 'new/provider', default_agent: 'lead', agents: { lead: { description: 'new', mode: 'all', model: 'new/provider', permissions: ['ask'], system: 'new' } } });
  const receipt = createReceipt(target, before, after);
  assert.equal(readInstallationReceipt(writeInstallationReceipt(root, receipt), target).complete, true);
  const result = planUninstall(receipt, after);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(JSON.parse(result.updated), JSON.parse(before));
  const dangling = createReceipt(target, '{"default_agent":"lead","agents":{"lead":{}}}', '{"default_agent":"other","agents":{"other":{}}}');
  assert.deepEqual(planUninstall(dangling, '{"default_agent":"other","agents":{"other":{}}}').conflicts, ['default_agent (would reference a missing agent)']);
});

test('adoption requires explicit per-field selection and records selected before-state only', () => {
  const current = '{"agents":{"lead":{"permissions":["ask"]}},"model":"p/m"}';
  const before = '{"agents":{"lead":{"permissions":["deny"]}},"model":"p/old"}';
  const receipt = adoptExisting('opencode.json', current, before, ['agents.lead.permissions'], [], []);
  assert.equal(receipt.provenance, 'user-adopted');
  assert.deepEqual(receipt.changes.map(change => change.path.join('.')), ['agents.lead.permissions']);
  const plan = planUninstall(receipt, current);
  assert.deepEqual(plan.conflicts, []);
  assert.match(plan.updated, /deny/);
  assert.match(plan.updated, /p\/m/);
  assert.throws(() => adoptExisting('opencode.json', current, before, [], ['model'], []), /acknowledgment/);
});

test('pending evidence precedes save; unchanged failure clears it and partial mutation retains it', t => {
  const root = makeTempRoot('harness-pending-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json'), before = '{"model":"old/p"}', after = '{"model":"new/p"}';
  writeFileSync(target, before);
  const receipt = createReceipt(target, before, after);
  const pending = writePendingReceipt(root, receipt);
  assert.equal(JSON.parse(readFileSync(pending, 'utf8')).status, 'pending');
  assert.equal(recoverFailedInstallation(pending, before, target), 'cleared');
  assert.equal(existsSync(pending), false);
  const partial = writePendingReceipt(root, receipt);
  writeFileSync(target, after);
  assert.equal(recoverFailedInstallation(partial, before, target), 'retained');
  assert.equal(JSON.parse(readFileSync(partial, 'utf8')).status, 'pending');
  completePendingReceipt(partial, createReceipt(target, before, readFileSync(target, 'utf8')));
  assert.equal(JSON.parse(readFileSync(partial, 'utf8')).status, 'complete');
});

test('receipt overlap is target/field aware and skips completed history restored to baseline', t => {
  const root = makeTempRoot('harness-overlap-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json'), other = join(root, 'other.json');
  const current = '{"model":"new/p","agents":{"lead":{"mode":"all"}}}';
  const first = createReceipt(target, '{"model":"old/p"}', '{"model":"new/p"}');
  const pending = writePendingReceipt(root, first);
  assert.throws(() => assertNoReceiptOverlap(root, target, createReceipt(target, current, '{"model":"next/p","agents":{"lead":{"mode":"all"}}}'), current), /overlaps/);
  assert.doesNotThrow(() => assertNoReceiptOverlap(root, other, createReceipt(other, current, '{"model":"next/p","agents":{"lead":{"mode":"all"}}}'), current));
  rmSync(pending);
  const completed = writeInstallationReceipt(root, first);
  assert.throws(() => assertNoReceiptOverlap(root, target, createReceipt(target, current, '{"model":"next/p","agents":{"lead":{"mode":"all"}}}'), current), /overlaps/);
  const restored = '{"model":"old/p","agents":{"lead":{"mode":"all"}}}';
  assert.doesNotThrow(() => assertNoReceiptOverlap(root, target, createReceipt(target, restored, '{"model":"next/p","agents":{"lead":{"mode":"all"}}}'), restored));
  assert.ok(existsSync(completed));
  const unrelated = writeInstallationReceipt(root, createReceipt(other, '{"model":"x/p"}', '{"model":"y/p"}'));
  assert.ok(readdirSync(root).includes(unrelated.split(/[\\/]/).pop()!));
});

test('uninstall removes only empty installer-created containers deepest first and is idempotent', () => {
  const target = 'opencode.json';
  const before = '{"custom":1}';
  const after = '{"custom":1,"agents":{"lead":{"model":"new/p"}}}';
  const receipt = createReceipt(target, before, after);
  assert.deepEqual(receipt.createdContainers, [['agents'], ['agents','lead']]);
  const result = planUninstall(receipt, after);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(JSON.parse(result.updated), { custom: 1 });
  const roleCleanup = result.actions.indexOf('agents.lead: remove empty installer-created container');
  const rootCleanup = result.actions.indexOf('agents: remove empty installer-created container');
  assert.ok(roleCleanup >= 0 && rootCleanup > roleCleanup, 'remove role container before its created parent');
  const custom = '{"custom":1,"agents":{"lead":{"color":"user"}}}';
  const preserved = planUninstall(receipt, custom);
  assert.equal(preserved.updated, custom);
  assert.deepEqual(planUninstall(receipt, result.updated).actions.filter(action => action.includes('remove empty')), []);
});

test('container cleanup parses evolving JSONC with BOM and CRLF and preserves user additions', () => {
  const target = 'opencode.jsonc';
  const before = '\uFEFF{\r\n  // keep this comment\r\n  "custom": 1\r\n}\r\n';
  const after = '\uFEFF{\r\n  // keep this comment\r\n  "custom": 1,\r\n  "agents": {\r\n    "lead": {\r\n      "model": "new/p"\r\n    }\r\n  }\r\n}\r\n';
  const receipt = createReceipt(target, before, after);
  const result = planUninstall(receipt, after);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.updated, before);
  assert.equal(result.updated.charCodeAt(0), 0xfeff);
  assert.match(result.updated, /\r\n/);
  assert.match(result.updated, /keep this comment/);
  assert.deepEqual(planUninstall(receipt, result.updated).actions.filter(action => action.includes('remove empty')), []);

  const preserved = after.replace('"model": "new/p"', '"model": "new/p",\r\n      // user-owned addition\r\n      "color": "blue"');
  const preservation = planUninstall(receipt, preserved);
  assert.deepEqual(preservation.conflicts, []);
  assert.match(preservation.updated, /"color": "blue"/);
  assert.match(preservation.updated, /"agents"/);
});

test('container cleanup removes trailing commas from emptied nested containers in JSONC', () => {
  const target = 'opencode.jsonc';
  const cases: [string, string][] = [
    ['{\r\n  "custom": true\r\n}\r\n', '{\r\n  "custom": true,\r\n  "agents": {\r\n    "lead": {\r\n      "model": "p/m",\r\n    },\r\n  },\r\n}\r\n'],
    ['\uFEFF{\n  "custom": true\n}\n', '\uFEFF{\n  "custom": true,\n  "agents": {\n    "lead": {\n      "model": "p/m",\n    },\n  },\n}\n'],
  ];
  for (const [before, after] of cases) {
    const receipt = createReceipt(target, before, after);
    const result = planUninstall(receipt, after);
    assert.deepEqual(result.conflicts, []);
    assert.match(result.updated, /"custom": true/);
    assert.doesNotMatch(result.updated, /\{\s*,/);
    assert.match(result.updated, /\r\n|\n/);
    assert.deepEqual(planUninstall(receipt, result.updated).actions.filter(action => action.includes('remove empty')), []);

    const userAdded = after.replace('"model": "p/m",', '"model": "p/m",\n      "color": "blue",');
    const preserved = planUninstall(receipt, userAdded);
    assert.deepEqual(preserved.conflicts, []);
    assert.match(preserved.updated, /"color": "blue"/);
    assert.match(preserved.updated, /"agents"/);
  }
});

test('container cleanup removes only selected commas across comments and preserves unrelated payloads', () => {
  const target = 'opencode.jsonc';
  const cases = [
    '{"agents":{"lead":{"model":"p/m", /* keep */},},"custom":"{,}","literal":"{ /* untouched */ , }"}',
    '{\n  "agents": { // role collection\n    "lead": { "model": "p/m" /* before comma */ , // comma follows comment\n    },\n  },\n  "custom": "{,}",\n  "escaped": "\\\"{,}\\\""\n}',
    '\uFEFF{\r\n  "agents": {\r\n    "lead": { "model": "p/m", /* trailing value comment */ },\r\n  },\r\n  "custom": "{,}"\r\n}\r\n',
  ];
  for (const after of cases) {
    const receipt = createReceipt(target, '{"custom":"{,}"}', after);
    const result = planUninstall(receipt, after);
    assert.deepEqual(result.conflicts, []);
    assert.doesNotMatch(result.updated, /"agents"/);
    assert.match(result.updated, /"custom"\s*:\s*"\{,\}"/);
    assert.deepEqual(planUninstall(receipt, result.updated).actions.filter(action => action.includes('remove empty')), []);
  }
});

test('adoption without evidence defaults to unmanaged, explicit evidence restores only same paths, and never changes config', t => {
  const root = makeTempRoot('harness-adoption-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json');
  const current = '{"agents":{"lead":{"model":"new/p","permissions":["ask"]}},"model":"new/p"}';
  const before = '{"agents":{"lead":{"model":"old/p","permissions":["deny"]}},"model":"old/p"}';
  writeFileSync(target, current);
  const keep = adoptExisting(target, current, undefined, [], [], []);
  assert.equal(keep.changes.length, 0);
  assert.equal(persistAdoptionReceipt(join(root, 'missing-recovery'), keep, current, undefined, undefined, true), undefined);
  assert.equal(existsSync(join(root, 'missing-recovery')), false);
  assert.throws(() => adoptExisting(target, current, undefined, ['model'], [], []), /without supplied/);
  const adopted = adoptExisting(target, current, before, ['agents.lead.permissions', 'model'], [], []);
  assert.deepEqual(adopted.changes.map(change => change.path.join('.')), ['agents.lead.permissions', 'model']);
  const receiptPath = persistAdoptionReceipt(join(root, 'recovery'), adopted, current, undefined, undefined, true)!;
  assert.equal(readFileSync(target, 'utf8'), current);
  const read = readInstallationReceipt(receiptPath, target);
  assert.equal(read.provenance, 'user-adopted');
  const uninstall = planUninstall(read, current);
  assert.deepEqual(JSON.parse(uninstall.updated), { agents: { lead: { model: 'new/p', permissions: ['deny'] } }, model: 'old/p' });
  assert.equal(readFileSync(target, 'utf8'), current, 'planning adoption uninstall must not mutate target');
});

test('adoption supports a bounded bulk field selection without inventing absent fields', () => {
  const target = join(tmpdir(), 'opencode.json');
  const current = JSON.stringify({ agents: { lead: { model: 'new/p', custom: 'keep' }, custom: { model: 'x/y' } }, model: 'new/p', unrelated: true });
  const before = JSON.stringify({ agents: { lead: { model: 'old/p' } }, model: 'old/p', unrelated: true });
  const selected = ['agents.lead.model', 'model'];
  const receipt = adoptExisting(target, current, before, selected, [], []);
  assert.deepEqual(receipt.changes.map(change => change.path.join('.')), selected);
  assert.equal(configurationField(current, ['agents', 'lead', 'description']), undefined);
  assert.equal(configurationField(current, ['agents', 'custom', 'model']), 'x/y');
  assert.equal(configurationField(current, ['unrelated']), true);
  assert.equal(JSON.stringify(parseConfiguration(current, target)), JSON.stringify(parseConfiguration(current, target)));
});

test('adoption acknowledgment, cancellation, and evidence/config concurrency are fail-safe', t => {
  const root = makeTempRoot('harness-adoption-guard-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json'), beforePath = join(root, 'before.json');
  const current = '{"model":"new/p"}', before = '{"model":"old/p"}';
  writeFileSync(target, current); writeFileSync(beforePath, before);
  assert.throws(() => adoptExisting(target, current, undefined, [], ['model'], []), /acknowledgment/);
  const removal = adoptExisting(target, current, undefined, [], ['model'], ['model']);
  assert.deepEqual(removal.changes[0]!.before, { absent: true });
  const restored = adoptExisting(target, current, before, ['model'], [], []);
  assert.equal(persistAdoptionReceipt(root, restored, current, beforePath, before, false), undefined);
  assert.equal(readdirSync(root).length, 2, 'cancel creates no receipt');
  writeFileSync(target, '{"model":"raced/p"}');
  assert.throws(() => persistAdoptionReceipt(root, restored, current, beforePath, before, true), /Configuration changed/);
  writeFileSync(target, current); writeFileSync(beforePath, '{"model":"raced-before/p"}');
  assert.throws(() => persistAdoptionReceipt(root, restored, current, beforePath, before, true), /evidence changed/);
  assert.equal(readdirSync(root).length, 2, 'races create no receipt');
});

test('receipt validation rejects duplicate JSON keys, forged paths/containers, invalid types and provenance', t => {
  const root = makeTempRoot('harness-receipt-strict-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'opencode.json'); writeFileSync(target, '{}');
  const valid = createReceipt(target, '{"model":"old/p"}', '{"model":"new/p"}');
  const file = (name: string, value: string) => { const path = join(root, name); writeFileSync(path, value); return path; };
  assert.throws(() => readInstallationReceipt(file('duplicate.json', '{"version":1,"version":1}'), target), /duplicate/);
  const mutate = (name: string, update: (receipt: any) => void) => {
    const receipt = structuredClone(valid) as any; update(receipt);
    assert.throws(() => readInstallationReceipt(file(name, JSON.stringify(receipt)), target));
  };
  mutate('dotted-path.json', receipt => { receipt.changes[0].path = ['model.x']; });
  mutate('bad-value.json', receipt => { receipt.changes[0].after = { value: [] }; });
  mutate('unknown-status.json', receipt => { receipt.status = 'finished'; });
  mutate('forged-container.json', receipt => { receipt.createdContainers = [['agents', 'customer']]; });
  mutate('container-provenance.json', receipt => { receipt.provenance = 'user-adopted'; receipt.createdContainers = [['agents']]; });
  mutate('wrong-shape.json', receipt => { receipt.changes[0].path = ['agents', 'lead.model', 'model']; });
  const modelReceipt = createReceipt(target, '{}', '{"agents":{"lead":{"model":"new/p"}}}');
  const dottedPath = structuredClone(modelReceipt) as any;
  dottedPath.changes[0].path = ['agents.lead.model'];
  assert.throws(() => readInstallationReceipt(file('dotted-segment.json', JSON.stringify(dottedPath)), target));
  const mixedPath = structuredClone(modelReceipt) as any;
  mixedPath.changes[0].path = ['agents', 'lead.model', 'model'];
  assert.throws(() => readInstallationReceipt(file('mixed-dotted-segment.json', JSON.stringify(mixedPath)), target));
  const pending = { ...valid, complete: false, status: 'pending' as const };
  const pendingPath = file('pending.json', JSON.stringify(pending));
  assert.throws(() => readInstallationReceipt(pendingPath, target));
  assert.equal(readInstallationReceipt(pendingPath, target, true).complete, false);
});

test('symlink ancestors and recovery output paths are refused without following links', t => {
  const root = makeTempRoot('harness-symlink-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real'); mkdirSync(real);
  const target = join(real, 'opencode.json'); writeFileSync(target, '{"model":"new/p"}');
  const link = join(root, 'linked');
  try { symlinkSync(real, link, 'junction'); } catch { t.skip('directory symlink creation is unavailable on this host'); return; }
  assert.throws(() => readInstallationReceipt(join(link, 'receipt.json'), target), /Symlink/);
  const linkedTarget = join(link, 'opencode.json');
  const linkedAdoption = adoptExisting(linkedTarget, '{"model":"new/p"}', '{"model":"old/p"}', ['model'], [], []);
  assert.throws(() => persistAdoptionReceipt(root, linkedAdoption, '{"model":"new/p"}', undefined, undefined, true), /Symlink/);
  const receipt = adoptExisting(target, '{}', '{}', ['model'], [], []);
  assert.equal(receipt.changes.length, 0);
  const adoption = adoptExisting(target, '{"model":"new/p"}', '{"model":"old/p"}', ['model'], [], []);
  assert.throws(() => persistAdoptionReceipt(join(link, 'recovery'), adoption, '{"model":"new/p"}', undefined, undefined, true), /Symlink/);
  assert.deepEqual(readdirSync(real), ['opencode.json']);
});
